export interface PageScriptExecutionResult<T = unknown> { tabId: number; frameId?: number; result?: T }

export type PageAction =
  | { type: 'inspect'; selector?: string }
  | { type: 'find'; text: string }
  | { type: 'highlight'; text: string }
  | { type: 'scroll'; selector: string }
  | { type: 'click'; selector: string };

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
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const query = (selector: string): Element | null => {
    try { return document.querySelector(selector); }
    catch { throw new Error('CSS selector 格式无效'); }
  };
  const findText = (needle: string) => {
    const wanted = needle.toLocaleLowerCase();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const matches: Array<{ node: Text; parent: HTMLElement; text: string }> = [];
    let node: Node | null;
    while ((node = walker.nextNode()) && matches.length < 12) {
      const parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|INPUT|SELECT|OPTION)$/i.test(parent.tagName)
        || parent.closest('[contenteditable="true"],[hidden],[aria-hidden="true"]') || !visible(parent)) continue;
      const value = node.textContent || '';
      if (value.toLocaleLowerCase().includes(wanted)) matches.push({ node: node as Text, parent, text: clean(value, 300) });
    }
    return matches;
  };

  if (!action || typeof action !== 'object') throw new Error('缺少页面操作参数');
  if (action.type === 'inspect') {
    const root = action.selector ? query(action.selector) : document.body || document.documentElement;
    if (!root) return { ok: false, message: '没有找到匹配的页面元素' };
    const element = root as HTMLElement;
    return {
      ok: true,
      message: '已读取页面可见内容',
      title: document.title,
      url: location.href,
      text: clean(element.innerText || element.textContent || '', 6000),
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
    return { ok: true, message: '已滚动到目标元素', target: { tag: target.tagName.toLowerCase(), label: clean(target.innerText || target.getAttribute('aria-label') || target.textContent || '', 160) } };
  }
  if (action.type === 'click') {
    const element = query(action.selector);
    const target = element?.closest('button,a[href],[role="button"],input[type="button"],input[type="submit"]') as HTMLElement | null;
    if (!target || !visible(target)) return { ok: false, message: '目标不是可见的按钮或链接' };
    if ((target as HTMLButtonElement).disabled) return { ok: false, message: '目标控件当前处于禁用状态' };
    const href = target instanceof HTMLAnchorElement ? target.href : undefined;
    if (href) {
      const parsed = new URL(href, location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, message: '已阻止非 HTTP(S) 链接' };
    }
    const label = clean(target.innerText || target.getAttribute('aria-label') || target.textContent || target.getAttribute('value') || '', 160);
    const highImpact = /(支付|付款|购买|下单|删除|移除|发送|发布|授权|确认|订阅|purchase|payment|pay now|delete|remove|send|submit|authorize|grant access|place order|unsubscribe)/i;
    const isSubmit = target instanceof HTMLButtonElement && target.type === 'submit'
      || target instanceof HTMLInputElement && target.type === 'submit';
    if (isSubmit || highImpact.test(label)) {
      return { ok: false, message: '已阻止潜在高影响操作（提交、支付、删除、发送或授权）；请使用网站自身界面完成此操作' };
    }
    target.click();
    return { ok: true, message: '已执行点击', target: { tag: target.tagName.toLowerCase(), label, ...(href ? { href } : {}) } };
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
    const results = await scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
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
  if (scripting?.executeScript) {
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
  throw new Error('This browser does not expose a script injection API');
}
