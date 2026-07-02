import browser from 'webextension-polyfill';
import { getConfig, setConfig, type Config } from '../utils/config';
import { showStatus, hideStatus } from './statusOverlay';

/**
 * 配置面板（点击浮动按钮长按出现）。
 *
 * 面板内容：
 *   - DeepSeek API Key（保存时实时验证）
 *   - 源语言（auto / en / zh / ja）
 *   - 目标语言（zh / en / ja）
 *   - 远程服务器翻译开关 + 地址 + Provider
 *   - 触屏手势固定为"三击翻译"
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
      <div class="fanyi-config-row">
        <label>翻译文风</label>
        <select class="fanyi-prompt-style">
          <option value="default">通用直译</option>
          <option value="jinyong">金庸武侠</option>
          <option value="acheng">阿城白描</option>
          <option value="wangxiaobo">王小波大白话</option>
        </select>
      </div>
      <div class="fanyi-config-row fanyi-config-switch">
        <label>
          <input type="checkbox" class="fanyi-use-server" />
          通过远程服务器翻译当前页面
        </label>
      </div>
      <div class="fanyi-server-group" style="display:none">
        <div class="fanyi-config-row fanyi-server-url-row">
          <label>服务端地址</label>
          <input type="text" class="fanyi-server-url" placeholder="https://s.sunxiunan.com/fanyi/page" />
        </div>
        <div class="fanyi-config-row">
          <label>服务端翻译 Provider</label>
          <select class="fanyi-provider">
            <option value="deepseek">DeepSeek</option>
            <option value="openrouter">OpenRouter</option>
            <option value="nvidia">NVIDIA</option>
            <option value="cloudflare">Cloudflare</option>
            <option value="gemini">Gemini</option>
            <option value="opencode">OpenCode</option>
          </select>
        </div>
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
  (panel.querySelector('.fanyi-provider') as HTMLSelectElement).value = config.provider || 'deepseek';
  (panel.querySelector('.fanyi-source-lang') as HTMLSelectElement).value = config.sourceLang || 'auto';
  (panel.querySelector('.fanyi-target-lang') as HTMLSelectElement).value = config.targetLang || 'zh';
  (panel.querySelector('.fanyi-prompt-style') as HTMLSelectElement).value = config.promptStyle || 'default';

  // 服务端翻译开关
  const useServerCheckbox = panel.querySelector('.fanyi-use-server') as HTMLInputElement | null;
  const serverGroup = panel.querySelector('.fanyi-server-group') as HTMLElement | null;
  if (useServerCheckbox) {
    useServerCheckbox.checked = config.useServerTranslation || false;
    const display = useServerCheckbox.checked ? '' : 'none';
    if (serverGroup) serverGroup.style.display = display;
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

  // 服务端翻译开关：切换显示/隐藏服务端地址和 Provider 整个 group
  const useServerCheckbox = panel.querySelector('.fanyi-use-server') as HTMLInputElement | null;
  const serverGroup = panel.querySelector('.fanyi-server-group') as HTMLElement | null;
  if (useServerCheckbox) {
    useServerCheckbox.addEventListener('change', () => {
      const display = useServerCheckbox.checked ? '' : 'none';
      if (serverGroup) serverGroup.style.display = display;
    });
  }
}

/** 收集面板上的表单值 → 按需验证 API Key → 成功则写入 storage。 */
async function saveConfigFromPanel(panel: HTMLElement, isMobile: boolean): Promise<void> {
  const apiKey = (panel.querySelector('.fanyi-api-input') as HTMLInputElement).value.trim();
  const useServerCheckbox = panel.querySelector('.fanyi-use-server') as HTMLInputElement | null;
  const useServer = useServerCheckbox?.checked ?? false;
  const providerSelect = panel.querySelector('.fanyi-provider') as HTMLSelectElement | null;
  const provider = (providerSelect?.value || 'deepseek') as Config['provider'];

  // 使用服务端翻译且 provider 不是 deepseek 时，才不需要本地 API Key；
  // 其他情况（本地翻译、或服务端翻译但 provider=deepseek）都需要 API Key。
  const needApiKey = !useServer || provider === 'deepseek';
  if (needApiKey && !apiKey) {
    showStatus('API Key 不能为空', 'error');
    setTimeout(hideStatus, 2000);
    return;
  }

  if (needApiKey) {
    showStatus('正在验证 API Key...', 'loading');
    try {
      const response = await browser.runtime.sendMessage({
        action: 'validateApiKey',
        apiKey,
      });
      console.log('[ContentScript] Validation response:', response);

      if (!(response as any)?.success) {
        const errorMsg = (response as any)?.error || '未知错误';
        console.error('[ContentScript] Validation failed:', errorMsg);
        showStatus('API Key 无效: ' + errorMsg, 'error');
        setTimeout(hideStatus, 5000);
        return;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '网络错误';
      console.error('[ContentScript] Validation error:', error);
      showStatus('验证失败: ' + errorMsg, 'error');
      setTimeout(hideStatus, 5000);
      return;
    }
  }

  // 验证通过或不需要验证：写入 storage
  const config = await getConfig();
  config.deepseekApiKey = apiKey;
  config.provider = (panel.querySelector('.fanyi-provider') as HTMLSelectElement).value as Config['provider'];
  config.sourceLang = (panel.querySelector('.fanyi-source-lang') as HTMLSelectElement).value;
  config.targetLang = (panel.querySelector('.fanyi-target-lang') as HTMLSelectElement).value;
  config.promptStyle = (panel.querySelector('.fanyi-prompt-style') as HTMLSelectElement).value as Config['promptStyle'];

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
}
