/**
 * A wrapper page (Hugging Face Spaces, embedded articles, hosted slides) often
 * has no translatable DOM of its own: all article text lives in a cross-origin
 * iframe. Content scripts run in child frames too, but translating every ad
 * iframe is wasteful. This conservative check is only called after the top
 * frame produced zero translatable blocks.
 */

const TRACKER_HOST_PATTERN =
  /(^|\.)(doubleclick|googlesyndication|googleadservices|facebook|twitter|stripe|recaptcha|analytics|ads?)\./i;

/** True when the page hosts at least one visible, reasonably large remote iframe. */
export function hasContentIframe(doc: Document = document): boolean {
  const viewportWidth = Math.max(doc.documentElement?.clientWidth || 0, 1);
  const viewportHeight = Math.max(doc.documentElement?.clientHeight || 0, 1);
  const minArea = viewportWidth * viewportHeight * 0.12;

  for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
    const rect = frame.getBoundingClientRect();
    if (rect.width < 320 || rect.height < 240) continue;
    if (rect.width * rect.height < minArea) continue;

    let src = '';
    try {
      src = frame.getAttribute('src') || frame.src || '';
      const url = new URL(src, doc.baseURI || 'https://invalid.local/');
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (TRACKER_HOST_PATTERN.test(url.hostname)) continue;
      src = url.href;
    } catch {
      continue;
    }
    if (!src) continue;

    const style = (doc.defaultView || window).getComputedStyle(frame);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    return true;
  }
  return false;
}
