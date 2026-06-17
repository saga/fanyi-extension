import browser from 'webextension-polyfill';
import { getConfig, setConfig } from '../utils/config';
import { showStatus, hideStatus } from './statusOverlay';

/**
 * 配置面板（点击浮动按钮长按出现）。
 *
 * 面板内容：
 *   - DeepSeek API Key（必填，保存时实时验证）
 *   - 源语言（auto / en / zh / ja）
 *   - 目标语言（zh / en / ja）
 *   - 翻译模式（双语 / 仅译文）
 *   - 触屏手势（仅移动端：三击 / 三指）
 *
 * 交互流程：
 *   1. 用户填好表 → 点保存 → 后台 validateApiKey
 *   2. 通过 → setConfig() 写入 storage → 显示 "设置已保存"
 *   3. 失败 → 显示 "API Key 无效: <error>"
 *   4. 面板上还有"翻译"和"恢复"按钮，等同浮动按钮短按
 *
 * 桌面端：点击面板外自动关闭（outside-click 监听，0 延迟挂载避免冒泡冲突）
 * 移动端：没有"外部"概念，只能通过右上角 × 关闭
 */
export function showConfigPanel(
  isMobile: boolean,
  onTranslate: () => Promise<void>,
  onRestore: () => void,
): void {
  // 已存在 → 关闭（再次长按 = 关闭）
  const existing = document.querySelector('.fanyi-config-panel');
  if (existing) {
    existing.remove();
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'fanyi-config-panel';
  panel.innerHTML = buildPanelHtml(isMobile);
  wirePanelEvents(panel, isMobile, onTranslate, onRestore);

  // 异步加载已保存的配置填到表单
  void loadConfigIntoPanel(panel, isMobile);

  // 桌面端：点外面关掉（setTimeout 0 让 click 事件先消化，避免刚创建就被关闭）
  if (!isMobile) {
    setTimeout(() => {
      document.addEventListener('click', function closeOnOutside(ev: MouseEvent) {
        const target = ev.target as Element;
        if (!panel.contains(target) && !target.closest('.fanyi-floating-btn')) {
          panel.remove();
          document.removeEventListener('click', closeOnOutside);
        }
      });
    }, 0);
  }

  document.body.appendChild(panel);
}

/** 构造面板 HTML（纯字符串模板，无 Vue 依赖）。 */
function buildPanelHtml(isMobile: boolean): string {
  return `
    <div class="fanyi-config-header">
      <span>翻译设置</span>
      <button class="fanyi-config-close">&times;</button>
    </div>
    <div class="fanyi-config-body">
      <div class="fanyi-config-row">
        <label>DeepSeek API Key</label>
        <input type="password" class="fanyi-api-input" placeholder="输入 DeepSeek API Key" />
      </div>
      <div class="fanyi-config-row">
        <label>源语言</label>
        <select class="fanyi-source-lang">
          <option value="auto">自动检测</option>
          <option value="en">英语</option>
          <option value="zh">中文</option>
          <option value="ja">日语</option>
        </select>
      </div>
      <div class="fanyi-config-row">
        <label>目标语言</label>
        <select class="fanyi-target-lang">
          <option value="zh">中文</option>
          <option value="en">英语</option>
          <option value="ja">日语</option>
        </select>
      </div>
      ${isMobile ? `
      <div class="fanyi-config-row">
        <label>触摸手势</label>
        <select class="fanyi-touch-gesture">
          <option value="TripleTap">三击翻译</option>
          <option value="ThreeFinger">三指翻译</option>
        </select>
      </div>
      ` : ''}
      <div class="fanyi-config-row fanyi-config-switch">
        <label>
          <input type="checkbox" class="fanyi-use-server" />
          使用服务端翻译
        </label>
      </div>
      <div class="fanyi-config-row fanyi-server-url-row" style="display:none">
        <label>服务端地址</label>
        <input type="text" class="fanyi-server-url" placeholder="https://s.sunxiunan.com/fanyi/page" />
      </div>
      <div class="fanyi-config-actions">
        <button class="fanyi-btn-save">保存</button>
        <button class="fanyi-btn-translate">翻译</button>
        <button class="fanyi-btn-restore">恢复</button>
      </div>
    </div>
  `;
}

/** 把已保存的 config 写回表单控件。 */
async function loadConfigIntoPanel(panel: HTMLElement, isMobile: boolean): Promise<void> {
  const config = await getConfig();
  (panel.querySelector('.fanyi-api-input') as HTMLInputElement).value = config.deepseekApiKey || '';
  (panel.querySelector('.fanyi-source-lang') as HTMLSelectElement).value = config.sourceLang || 'auto';
  (panel.querySelector('.fanyi-target-lang') as HTMLSelectElement).value = config.targetLang || 'zh';

  if (isMobile) {
    const gestureSelect = panel.querySelector('.fanyi-touch-gesture') as HTMLSelectElement | null;
    if (gestureSelect) gestureSelect.value = config.touchGesture || 'TripleTap';
  }

  // 服务端翻译开关
  const useServerCheckbox = panel.querySelector('.fanyi-use-server') as HTMLInputElement | null;
  const serverUrlRow = panel.querySelector('.fanyi-server-url-row') as HTMLElement | null;
  if (useServerCheckbox) {
    useServerCheckbox.checked = config.useServerTranslation || false;
    if (serverUrlRow) {
      serverUrlRow.style.display = useServerCheckbox.checked ? '' : 'none';
    }
  }
  const serverUrlInput = panel.querySelector('.fanyi-server-url') as HTMLInputElement | null;
  if (serverUrlInput) {
    serverUrlInput.value = config.serverUrl || 'https://s.sunxiunan.com/fanyi/page';
  }
}

/** 绑定关闭、保存、翻译、恢复四个按钮的点击事件。 */
function wirePanelEvents(
  panel: HTMLElement,
  isMobile: boolean,
  onTranslate: () => Promise<void>,
  onRestore: () => void,
): void {
  // 关闭按钮
  panel.querySelector('.fanyi-config-close')?.addEventListener('click', () => panel.remove());

  // 保存按钮：先验证 API Key，成功才写 storage
  panel.querySelector('.fanyi-btn-save')?.addEventListener('click', () => {
    void saveConfigFromPanel(panel, isMobile);
  });

  // 翻译按钮 = 关掉面板 + 触发翻译
  panel.querySelector('.fanyi-btn-translate')?.addEventListener('click', async () => {
    panel.remove();
    await onTranslate();
  });

  // 恢复按钮 = 关掉面板 + 触发恢复
  panel.querySelector('.fanyi-btn-restore')?.addEventListener('click', () => {
    panel.remove();
    onRestore();
  });

  // 服务端翻译开关：切换显示/隐藏服务端地址输入框
  const useServerCheckbox = panel.querySelector('.fanyi-use-server') as HTMLInputElement | null;
  const serverUrlRow = panel.querySelector('.fanyi-server-url-row') as HTMLElement | null;
  if (useServerCheckbox && serverUrlRow) {
    useServerCheckbox.addEventListener('change', () => {
      serverUrlRow.style.display = useServerCheckbox.checked ? '' : 'none';
    });
  }
}

/** 收集面板上的表单值 → 调 background 验证 API Key → 成功则写入 storage。 */
async function saveConfigFromPanel(panel: HTMLElement, isMobile: boolean): Promise<void> {
  const apiKey = (panel.querySelector('.fanyi-api-input') as HTMLInputElement).value.trim();
  if (!apiKey) {
    showStatus('API Key 不能为空', 'error');
    setTimeout(hideStatus, 2000);
    return;
  }

  showStatus('正在验证 API Key...', 'loading');
  try {
    const response = await browser.runtime.sendMessage({
      action: 'validateApiKey',
      apiKey,
    });
    console.log('[ContentScript] Validation response:', response);

    if (response?.success) {
      const config = await getConfig();
      config.deepseekApiKey = apiKey;
      config.sourceLang = (panel.querySelector('.fanyi-source-lang') as HTMLSelectElement).value;
      config.targetLang = (panel.querySelector('.fanyi-target-lang') as HTMLSelectElement).value;

      if (isMobile) {
        const gestureSelect = panel.querySelector('.fanyi-touch-gesture') as HTMLSelectElement | null;
        if (gestureSelect) config.touchGesture = gestureSelect.value;
      }

      const useServerCheckbox = panel.querySelector('.fanyi-use-server') as HTMLInputElement | null;
      if (useServerCheckbox) {
        config.useServerTranslation = useServerCheckbox.checked;
      }
      const serverUrlInput = panel.querySelector('.fanyi-server-url') as HTMLInputElement | null;
      if (serverUrlInput) {
        const url = serverUrlInput.value.trim();
        config.serverUrl = url || 'https://s.sunxiunan.com/fanyi/page';
      }

      await setConfig(config);
      showStatus('设置已保存', 'success');
      setTimeout(hideStatus, 2000);
    } else {
      const errorMsg = (response as any)?.error || '未知错误';
      console.error('[ContentScript] Validation failed:', errorMsg);
      showStatus('API Key 无效: ' + errorMsg, 'error');
      setTimeout(hideStatus, 5000);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '网络错误';
    console.error('[ContentScript] Validation error:', error);
    showStatus('验证失败: ' + errorMsg, 'error');
    setTimeout(hideStatus, 5000);
  }
}
