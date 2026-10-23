/**
 * Detect obvious registrar parking pages before any webpage-translation provider runs.
 * Keep the rule narrow so ordinary articles discussing domains are not rejected.
 */
const PARKING_TITLE_PATTERN =
  /^\s*[^<>]{1,160}\s[-|·–—]\s[^<>]{1,100}\s+resources and information\.?\s*$/i;
const PARKING_BODY_PATTERN =
  /\b(?:this domain (?:is|may be) for sale|domain (?:is|has been) parked|buy this domain|this web page is parked|domain name.{0,80}for sale)\b/i;

function safePageLabel(value: string): string {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return '';
  }
}

export function getDomainParkingPageMessage(doc: Document, pageUrl = ''): string | null {
  const title = (doc.title || '').replace(/\s+/g, ' ').trim();
  const bodyText = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
  const titleLooksParked = PARKING_TITLE_PATTERN.test(title);
  const bodyLooksParked =
    bodyText.length < 20_000 && PARKING_BODY_PATTERN.test(bodyText);
  const shortParkingTemplate =
    bodyText.length < 5_000 &&
    /\brelated searches\b/i.test(bodyText) &&
    /\bprivacy policy\b/i.test(bodyText);

  if (!titleLooksParked && !bodyLooksParked && !shortParkingTemplate) return null;

  const reason = titleLooksParked
    ? '网页标题符合常见域名停放页模板'
    : '网页正文包含域名停放或域名出售提示';
  const page = safePageLabel(pageUrl);
  return [
    '当前页面疑似域名停放页，已停止网页翻译，避免将错误页面当作文章正文。',
    reason,
    page ? `页面：${page}` : '',
    title ? `标题：${title.slice(0, 160)}` : '',
  ].filter(Boolean).join(' ');
}
