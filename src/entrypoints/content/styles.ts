/**
 * content script 注入页面的全部 CSS。
 *
 * 之所以单独抽出：
 *  - 主文件减少 60+ 行模板字符串，专注业务逻辑
 *  - 改样式时不用在 1000 行文件里翻找
 *  - 移动/桌面分支（isMobile）只在一处集中处理
 *
 * 类名约定（避免与站点样式冲突，全部加 fanyi- 前缀）：
 *   fanyi-status-overlay  状态提示条
 *   fanyi-loading/success/error 状态条颜色
 *   fanyi-original/translation/missing  翻译渲染
 *   fanyi-floating-btn   浮动按钮
 *   fanyi-btn-translated 已翻译时按钮变绿
 *   fanyi-config-panel   配置面板
 *   fanyi-btn-save/translate/restore 配置面板按钮
 */
export function getStyles(isMobile: boolean): string {
  return `
    .fanyi-status-overlay {
      position: fixed;
      bottom: ${isMobile ? '70px' : '24px'};
      left: 50%;
      transform: translateX(-50%);
      padding: ${isMobile ? '10px 20px' : '14px 28px'};
      background: rgba(0, 0, 0, 0.72);
      color: rgba(255, 255, 255, 0.96);
      border-radius: 24px;
      z-index: 999999;
      font-size: ${isMobile ? '14px' : '16px'};
      font-weight: 500;
      display: none;
      max-width: 80%;
      text-align: center;
      pointer-events: none;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    }
    .fanyi-loading { border: 1px solid rgba(64, 158, 255, 0.3); }
    .fanyi-success { border: 1px solid rgba(103, 194, 58, 0.3); }
    .fanyi-error { border: 1px solid rgba(245, 108, 108, 0.3); }

    .fanyi-original {
      display: block;
    }
    .fanyi-translation {
      display: block;
    }
    /* 未翻译成功的段落：黄色高亮 + help 光标，鼠标悬停时由 title 提示原因。 */
    .fanyi-missing {
      background: linear-gradient(transparent 60%, rgba(255, 215, 0, 0.35) 60%);
      cursor: help;
    }

    .fanyi-btn-save,
    .fanyi-btn-translate,
    .fanyi-btn-restore {
      flex: 1;
      padding: ${isMobile ? '8px 10px' : '10px 12px'};
      border: 1px solid #e0e0e0;
      border-radius: 10px;
      background: white;
      cursor: pointer;
      font-size: ${isMobile ? '12px' : '13px'};
      font-weight: 600;
      white-space: nowrap;
    }
    .fanyi-btn-save {
      background: linear-gradient(135deg, #409eff, #66b1ff);
      color: white;
      border: none;
    }
    .fanyi-btn-translate {
      background: linear-gradient(135deg, #67c23a, #85ce61);
      color: white;
      border: none;
    }
    .fanyi-btn-restore {
      background: linear-gradient(135deg, #e6a23c, #ebb563);
      color: white;
      border: none;
    }
    .fanyi-btn-save:active,
    .fanyi-btn-translate:active,
    .fanyi-btn-restore:active {
      opacity: 0.8;
      transform: scale(0.98);
    }
    .fanyi-floating-btn.fanyi-btn-translated {
      background: linear-gradient(135deg, #67c23a, #85ce61);
      color: white;
    }

    /* 低优先级元素视觉弱化（保留 DOM，hover 恢复） */
    [data-fanyi-low-priority="true"] {
      opacity: 0.35 !important;
      filter: grayscale(60%) !important;
      transition: opacity 0.2s ease, filter 0.2s ease !important;
    }
    [data-fanyi-low-priority="true"]:hover {
      opacity: 1 !important;
      filter: none !important;
    }

    /* 弹窗 / overlay / cookie banner 直接隐藏 */
    [data-fanyi-remove="true"] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
}
