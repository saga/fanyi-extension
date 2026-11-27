export interface PageScriptExecutionResult<T = unknown> { tabId: number; frameId?: number; result?: T }

export type PageAction = (
  | { type: 'inspect'; selector?: string }
  | { type: 'find'; text: string }
  | { type: 'highlight'; text: string }
  | { type: 'scroll'; selector: string }
  | { type: 'clickPreview'; selector: string }
  | { type: 'click'; selector: string; expectedTarget?: { tag: string; label: string; href?: string } }
) & { expectedPageUrl?: string };

export interface PageActionResult {
  ok: boolean;
  message: string;
  title?: string;
  url?: string;
  text?: string;
  matches?: Array<{ tag: string; id: string; className: string; text: string }>;
  target?: { tag: string; label: string; href?: string };
}

/**
 * Static, isolated-world page operation. The model supplies only data arguments;
 * it never supplies executable source. Keep this function self-contained because
 * browsers serialize it into the target tab.
 */
function runPageAction(action: PageAction): PageActionResult {
  const clean = (value: string, max = 6000) => value.replace(/\s+/g, ' ').trim().slice(0, max);
  const visible = (element: Element | null): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && !element.closest('[hidden],[aria-hidden="true"],[inert]')
      && element.getClientRects().length > 0;
  };
  const query = (selector: string): Element | null => {
    try { return document.querySelector(selector); }
    catch { throw new Error('CSS selector 格式无效'); }
  };
  const readVisibleText = (root: Element): string => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    let node: Node | null;
    let scannedNodes = 0;
    let totalLength = 0;
    while ((node = walker.nextNode()) && scannedNodes < 10000) {
      scannedNodes++;
      const parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|SELECT|OPTION)$/i.test(parent.tagName)
        || parent.closest('[contenteditable="true"],[role="textbox"],[hidden],[aria-hidden="true"],[inert]')
        || !visible(parent)) continue;
      const value = node.textContent || '';
      if (value.trim()) {
        parts.push(value);
        totalLength += value.length;
      }
      if (totalLength >= 7000) break;
    }
    return clean(parts.join(' '), 6000);
  };
  const findText = (needle: string) => {
    const wanted = needle.toLocaleLowerCase();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const matches: Array<{ node: Text; parent: HTMLElement; text: string }> = [];
    let node: Node | null;
    let scannedNodes = 0;
    while ((node = walker.nextNode()) && matches.length < 12 && scannedNodes < 5000) {
      scannedNodes++;
      const parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|SELECT|OPTION)$/i.test(parent.tagName)
        || parent.closest('[contenteditable="true"],[role="textbox"],[hidden],[aria-hidden="true"],[inert]') || !visible(parent)) continue;
      const value = node.textContent || '';
      if (value.toLocaleLowerCase().includes(wanted)) matches.push({ node: node as Text, parent, text: clean(value, 300) });
    }
    return matches;
  };

  if (!action || typeof action !== 'object') throw new Error('缺少页面操作参数');
  if (action.expectedPageUrl) {
    try {
      const expected = new URL(action.expectedPageUrl);
      const current = new URL(location.href);
      expected.hash = '';
      current.hash = '';
      if (expected.href !== current.href) return { ok: false, message: '页面地址已变化，请重新加载页面上下文后再执行操作' };
    } catch {
      return { ok: false, message: '页面上下文 URL 无效，已取消操作' };
    }
  }
  if (action.type === 'inspect') {
    const root = action.selector ? query(action.selector) : document.body || document.documentElement;
    if (!root || !visible(root)) return { ok: false, message: '没有找到可见的页面元素' };
    if (/^(INPUT|TEXTAREA|SELECT|OPTION)$/i.test(root.tagName) || root.closest('[contenteditable="true"],[role="textbox"]')) {
      return { ok: false, message: '为避免读取用户输入，不读取表单控件或可编辑区域' };
    }
    const element = root as HTMLElement;
    return {
      ok: true,
      message: '已读取页面可见内容',
      title: document.title,
      url: location.href,
      // Read only visible text nodes; do not expose hidden DOM or user-editable fields.
      text: readVisibleText(element),
    };
  }
  if (action.type === 'find') {
    const matches = findText(action.text);
    return {
      ok: true,
      message: matches.length ? `找到 ${matches.length} 处匹配文字` : '没有找到匹配文字',
      matches: matches.map(({ parent, text }) => ({
        tag: parent.tagName.toLowerCase(),
        id: parent.id || '',
        className: typeof parent.className === 'string' ? parent.className.slice(0, 120) : '',
        text,
      })),
    };
  }
  if (action.type === 'highlight') {
    const found = findText(action.text)[0];
    if (!found) return { ok: false, message: '没有找到要定位的文字' };
    const start = found.node.textContent?.toLocaleLowerCase().indexOf(action.text.toLocaleLowerCase()) ?? -1;
    if (start < 0) return { ok: false, message: '无法定位匹配文字' };
    const range = document.createRange();
    range.setStart(found.node, start);
    range.setEnd(found.node, start + action.text.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    found.parent.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return { ok: true, message: '已选中并滚动到匹配文字', target: { tag: found.parent.tagName.toLowerCase(), label: clean(found.text, 160) } };
  }
  if (action.type === 'scroll') {
    const element = query(action.selector);
    if (!element || !visible(element)) return { ok: false, message: '没有找到可见的目标元素' };
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const target = element as HTMLElement;
    return { ok: true, message: '已滚动到目标元素', target: { tag: target.tagName.toLowerCase(), label: clean(readVisibleText(target) || target.getAttribute('aria-label') || '', 160) } };
  }
  if (action.type === 'clickPreview' || action.type === 'click') {
    const element = query(action.selector);
    const target = element?.closest('button,a[href],[role="button"],input[type="button"],input[type="submit"]') as HTMLElement | null;
    if (!target || !visible(target)) return { ok: false, message: '目标不是可见的按钮或链接' };
    if ((target as HTMLButtonElement).disabled) return { ok: false, message: '目标控件当前处于禁用状态' };
    const href = target instanceof HTMLAnchorElement ? target.href : undefined;
    if (href) {
      const parsed = new URL(href, location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, message: '已阻止非 HTTP(S) 链接' };
      if (parsed.username || parsed.password) return { ok: false, message: '已阻止包含账号或密码的链接' };
    }
    const label = clean([
      readVisibleText(target),
      target.getAttribute('aria-label'),
      target.getAttribute('title'),
      target.getAttribute('value'),
    ].filter(Boolean).join(' '), 160);
    const targetInfo = { tag: target.tagName.toLowerCase(), label, ...(href ? { href } : {}) };
    const highImpact = /(支付|付款|购买|下单|删除|移除|发送|发布|授权|确认|订阅|purchase|payment|pay now|delete|remove|send|submit|authorize|grant access|place order|unsubscribe)/i;
    const isSubmit = (target instanceof HTMLButtonElement && target.type === 'submit')
      || (target instanceof HTMLInputElement && target.type === 'submit');
    const sensitiveDestination = !!href && /\/(?:delete|remove|purchase|checkout|payment|logout|unsubscribe)(?:[/?#]|$)/i.test(new URL(href).pathname);
    if (isSubmit || highImpact.test(label) || sensitiveDestination) {
      return { ok: false, message: '已阻止潜在高影响操作（表单提交、支付、删除、发送、授权或敏感导航）', target: targetInfo };
    }
    if (action.type === 'clickPreview') {
      return { ok: true, message: '已解析点击目标，尚未执行', target: targetInfo };
    }
    if (!action.expectedTarget
      || action.expectedTarget.tag !== targetInfo.tag
      || action.expectedTarget.label !== targetInfo.label
      || action.expectedTarget.href !== targetInfo.href) {
      return { ok: false, message: '页面目标已变化或未经过预览确认，请重新请求并检查目标', target: targetInfo };
    }
    target.click();
    return { ok: true, message: '已执行点击', target: targetInfo };
  }
  throw new Error('不支持的页面操作');
}

/** Runs a fixed allow-listed DOM action in the isolated world of the chosen source tab. */
export async function executePageAction(
  tabId: number,
  action: PageAction,
  browserApi: any = (globalThis as any).browser,
  chromeApi: any = (globalThis as any).chrome,
): Promise<PageScriptExecutionResult<PageActionResult>> {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab ID');
  const serialized = JSON.stringify(action);
  if (serialized.length > 4096) throw new Error('页面操作参数过长');
  const scripting = chromeApi?.scripting ?? browserApi?.scripting;
  if (scripting?.executeScript) {
    // The default execution world is ISOLATED. Omitting the world property is
    // required for older supported Firefox versions (the property was added later).
    const results = await scripting.executeScript({
      target: { tabId },
      func: runPageAction,
      args: [action],
    });
    const first = results?.[0];
    return { tabId, frameId: first?.frameId, result: first?.result as PageActionResult };
  }
  if (browserApi?.tabs?.executeScript) {
    const code = `(${runPageAction.toString()})(${serialized})`;
    const results = await browserApi.tabs.executeScript(tabId, { code, runAt: 'document_idle' });
    return { tabId, result: results?.[0] as PageActionResult };
  }
  throw new Error('当前浏览器不支持脚本注入 API');
}

/**
 * Legacy low-level adapter retained for trusted extension-authored snippets only.
 * Never pass model output, page content or remote text as source.
 */
export async function executePageScript<T = unknown>(
  tabId: number,
  source: string,
  browserApi: any = (globalThis as any).browser,
  chromeApi: any = (globalThis as any).chrome,
): Promise<PageScriptExecutionResult<T>> {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab ID');
  if (!source.trim()) throw new Error('Script is empty');
  const scripting = chromeApi?.scripting ?? browserApi?.scripting;
  let supportsMainWorld = !!scripting?.executeScript;

  // Firefox only added the scripting.world option in Firefox 128. Earlier
  // releases can still use the MV2 tabs.executeScript fallback (isolated world).
  if (browserApi?.runtime?.getBrowserInfo) {
    try {
      const info = await browserApi.runtime.getBrowserInfo();
      const major = Number.parseInt(String(info.version).split('.')[0] ?? '', 10);
      supportsMainWorld = supportsMainWorld && Number.isFinite(major) && major >= 128;
    } catch {
      supportsMainWorld = false;
    }
  }

  if (supportsMainWorld) {
    const results = await scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (code: string) => (0, eval)(code),
      args: [source],
    });
    const first = results?.[0];
    return { tabId, frameId: first?.frameId, result: first?.result as T };
  }

  if (browserApi?.tabs?.executeScript) {
    const results = await browserApi.tabs.executeScript(tabId, {
      code: '(function(){ return (0, eval)(' + JSON.stringify(source) + '); })()',
      runAt: 'document_idle',
    });
    return { tabId, result: results?.[0] as T };
  }
  throw new Error('This browser does not expose a compatible page script injection API');
}
