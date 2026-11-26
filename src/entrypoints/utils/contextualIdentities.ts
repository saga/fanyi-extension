export interface BrowserIdentity { cookieStoreId: string; name: string; color: string; icon: string }
export function hasContextualIdentities(browserApi: any = (globalThis as any).browser): boolean { return !!browserApi?.contextualIdentities?.query }
export async function listContextualIdentities(browserApi: any = (globalThis as any).browser): Promise<BrowserIdentity[]> {
  if (!hasContextualIdentities(browserApi)) throw new Error('当前浏览器不支持 Firefox Contextual Identities');
  const items = await browserApi.contextualIdentities.query({});
  return items.map((item: any) => ({ cookieStoreId: item.cookieStoreId, name: item.name, color: item.color, icon: item.icon }));
}
export async function createTabInIdentity(url: string, cookieStoreId: string, browserApi: any = (globalThis as any).browser): Promise<unknown> {
  if (!hasContextualIdentities(browserApi)) throw new Error('当前浏览器不支持 Firefox Contextual Identities');
  if (!/^https?:\/\//i.test(url)) throw new Error('Only HTTP(S) URLs are allowed');
  if (!cookieStoreId) throw new Error('A cookieStoreId is required');
  return browserApi.tabs.create({ url, cookieStoreId });
}
