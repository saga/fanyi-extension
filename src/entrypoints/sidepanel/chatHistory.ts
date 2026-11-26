/** Build a short storage key scoped to both the source tab and its page URL. */
export function createChatHistoryKey(tabId: number, url: string): string {
  let normalized = url.trim();
  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    normalized = parsed.toString();
  } catch {
    normalized = normalized || 'manual-context';
  }

  // FNV-1a keeps full URLs (including potentially sensitive query values) out of storage keys.
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash = Math.imul(hash ^ normalized.charCodeAt(i), 0x01000193);
  }
  return `chatHistory:${tabId}:${(hash >>> 0).toString(16)}`;
}
