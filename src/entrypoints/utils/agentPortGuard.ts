/**
 * Only the extension's own sidepanel document may open privileged chat and
 * network-inspector ports. Content scripts run on arbitrary websites and must
 * not be able to subscribe to captured requests or request Agent tool execution.
 */
export function isSidepanelPortUrl(senderUrl: string | undefined, sidepanelUrl: string): boolean {
  if (!senderUrl) return false;
  try {
    const sender = new URL(senderUrl);
    const expected = new URL(sidepanelUrl);
    // Extension schemes may expose an opaque `origin` string (`null`) through
    // generic URL implementations. Compare the scheme and extension ID explicitly.
    return sender.protocol === expected.protocol
      && sender.host === expected.host
      && sender.pathname === expected.pathname;
  } catch {
    return false;
  }
}
