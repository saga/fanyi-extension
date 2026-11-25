/**
 * Generic PDF source discovery.
 *
 * Web pages frequently wrap a PDF instead of being one:
 *   - IEEE `stamp.jsp` → full-screen <iframe src=".../paper.pdf?...">
 *   - institutional readers → <embed type="application/pdf" src="...">
 *   - nested wrapper iframes → PDF a few levels down
 *
 * The old translation entry only recognised arxiv.org/pdf/* in the popup, and the
 * content script only recognised PDF.js DOM markers. Neither matches a wrapper page,
 * so the user saw "No translatable content found" with no PDF route offered.
 *
 * This module is intentionally site-agnostic: it looks at URL shape, iframe/embed
 * attributes and accessible same-origin child documents only. No host allowlist.
 */

export interface PdfSource {
  url: string;
  via: 'self' | 'iframe' | 'embed' | 'object' | 'link';
}

const MAX_IFRAMES = 32;
const MAX_DEPTH = 4;

function absoluteUrl(value: string, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return null;
    }
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** URL-shape check. Covers `*.pdf`, `/pdf`, and `/pdf/<paper-id>` (arXiv style). */
export function isPdfUrl(value: string): boolean {
  const url = absoluteUrl(value, 'https://invalid.local/');
  if (!url) return false;
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (/\.pdf$/i.test(path) || /\/pdf$/i.test(path)) return true;
  const lastSegment = path.split('/').pop() || '';
  if (/\/pdf\//i.test(path) && !/\.(?:html?|php|jsp|aspx?)$/i.test(lastSegment)) return true;
  const format = parsed.searchParams.get('type') || parsed.searchParams.get('format') || '';
  return /pdf/i.test(format);
}

/**
 * Paper landing pages sometimes inject their inline PDF viewer only on wide,
 * hover-capable screens. On narrower/touch screens they leave only ordinary
 * `<a href="...pdf">Read the paper</a>` links. Treat such links as the PDF source
 * only when the page clearly presents them as the primary document.
 *
 * Avoid hijacking ordinary articles that merely have one "Download PDF" link:
 * require either two+ links to the same PDF with a paper/PDF action label, or
 * a primary label on a `/paper/`-style landing page.
 */
function findPdfLink(doc: Document, base: string, pageHref: string): PdfSource | null {
  const groups = new Map<string, { url: string; labels: string[] }>();

  for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
    const url = absoluteUrl(anchor.getAttribute('href') || '', base);
    if (!url || !isPdfUrl(url)) continue;
    const label = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
    const group = groups.get(url) || { url, labels: [] };
    group.labels.push(label);
    groups.set(url, group);
  }

  let paperLandingPage = false;
  try {
    paperLandingPage = /(^|\/)papers?(\/|$)/i.test(new URL(pageHref).pathname);
  } catch {
    paperLandingPage = false;
  }

  const primaryLabel = /^(read|open|view|download|see)\s+(the\s+)?(paper|pdf|article|preprint|full\s+text)\b|^pdf$|^paper$/i;
  for (const group of groups.values()) {
    const hasPrimaryLabel = group.labels.some((label) => primaryLabel.test(label));
    if (hasPrimaryLabel && (group.labels.length >= 2 || paperLandingPage)) {
      return { url: group.url, via: 'link' };
    }
  }
  return null;
}

/**
 * Find a public HTTP(S) PDF URL reachable from `doc`.
 *
 * Cross-origin iframes cannot be inspected; their `src` attribute is still checked,
 * which is enough for the common wrapper case. Same-origin child documents are
 * scanned recursively so nested wrappers work too.
 */
export function findPdfSource(doc: Document, href = doc.URL || ''): PdfSource | null {
  const self = absoluteUrl(href, 'https://invalid.local/');
  if (self && isPdfUrl(self)) return { url: self, via: 'self' };

  const visited = new Set<Document>();
  let framesSeen = 0;
  // srcdoc / detached documents have an `about:blank` baseURI; fall back to the
  // page URL so relative iframe src attributes still resolve to HTTP(S).
  const baseFor = (root: Document): string =>
    absoluteUrl(root.baseURI || '', 'https://invalid.local/') ||
    absoluteUrl(root.URL || '', 'https://invalid.local/') ||
    self ||
    'https://invalid.local/';

  const scan = (root: Document, depth: number): PdfSource | null => {
    if (depth > MAX_DEPTH || visited.has(root)) return null;
    visited.add(root);

    const base = baseFor(root);
    for (const el of Array.from(root.querySelectorAll('embed, object'))) {
      const attr = el.tagName.toLowerCase() === 'object' ? 'data' : 'src';
      const candidate = absoluteUrl(el.getAttribute(attr) || '', base);
      const type = el.getAttribute('type') || '';
      if (candidate && (isPdfUrl(candidate) || /pdf/i.test(type))) {
        return { url: candidate, via: el.tagName.toLowerCase() === 'object' ? 'object' : 'embed' };
      }
    }

    for (const frame of Array.from(root.querySelectorAll('iframe, frame'))) {
      if (framesSeen++ >= MAX_IFRAMES) break;
      const candidate = absoluteUrl(frame.getAttribute('src') || '', base);
      if (candidate && isPdfUrl(candidate)) return { url: candidate, via: 'iframe' };

      let child: Document | null = null;
      try {
        child = (frame as HTMLIFrameElement).contentDocument ?? null;
      } catch {
        child = null; // Cross-origin: only the src attribute is available.
      }
      if (!child) continue;
      if (isPdfUrl(child.URL)) return { url: child.URL, via: 'iframe' };
      // A wrapper iframe (including srcdoc/about:blank) can contain another iframe/embed.
      const nested = scan(child, depth + 1);
      if (nested) return nested;
    }
    return null;
  };

  const embedded = scan(doc, 0);
  if (embedded) return embedded;

  // Last resort: a paper landing page whose JS-driven viewer did not render.
  return findPdfLink(doc, baseFor(doc), self || '');
}
