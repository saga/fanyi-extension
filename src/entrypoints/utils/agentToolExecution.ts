import type { AgentToolRequest } from './agentToolProtocol';
import { createExtensionPasskey, getExtensionPasskey, getWebAuthnClientOrigin, getWebAuthnCapability } from './webAuthn';
import { listContextualIdentities, createTabInIdentity } from './contextualIdentities';

export interface AgentToolArtifact {
  title: string;
  json: string;
  origin?: string | null;
}

function toBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function serializeCredential(credential: PublicKeyCredential, operation: 'create' | 'get'): Record<string, unknown> {
  const response = credential.response;
  const payload: Record<string, unknown> = {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
  if (operation === 'create' && 'attestationObject' in response) {
    const creation = response as AuthenticatorAttestationResponse;
    payload.response = {
      clientDataJSON: toBase64Url(creation.clientDataJSON),
      attestationObject: toBase64Url(creation.attestationObject),
      transports: creation.getTransports?.() ?? [],
    };
  } else if (operation === 'get' && 'authenticatorData' in response) {
    const assertion = response as AuthenticatorAssertionResponse;
    payload.response = {
      clientDataJSON: toBase64Url(assertion.clientDataJSON),
      authenticatorData: toBase64Url(assertion.authenticatorData),
      signature: toBase64Url(assertion.signature),
      userHandle: assertion.userHandle ? toBase64Url(assertion.userHandle) : null,
    };
  } else {
    throw new Error('浏览器返回了无法识别的 PublicKeyCredential 响应');
  }
  return payload;
}

/**
 * Called directly by the user's approval click. WebAuthn create/get are invoked
 * before the first asynchronous boundary so browsers retain transient user activation.
 */
export async function executeAgentToolInExtension(
  request: AgentToolRequest,
  sourceTabId: number | undefined,
  browserApi: any = (globalThis as any).browser,
): Promise<{ summary: string; artifact?: AgentToolArtifact }> {
  const args = request.arguments;
  if (request.tool.startsWith('page.')) {
    if (!Number.isInteger(sourceTabId) || (sourceTabId as number) < 0) throw new Error('当前对话没有有效的来源标签页');
    const { executePageAction } = await import('./pageScriptExecution');
    const action = request.tool === 'page.inspect' ? { type: 'inspect' as const, ...(args.selector ? { selector: String(args.selector) } : {}) }
      : request.tool === 'page.find' ? { type: 'find' as const, text: String(args.text) }
      : request.tool === 'page.highlight' ? { type: 'highlight' as const, text: String(args.text) }
      : request.tool === 'page.scroll' ? { type: 'scroll' as const, selector: String(args.selector) }
      : { type: 'click' as const, selector: String(args.selector) };
    const result = (await executePageAction(sourceTabId as number, action, browserApi, (globalThis as any).chrome)).result;
    if (!result) throw new Error('页面操作没有返回结果');
    return { summary: JSON.stringify(result) };
  }

  if (request.tool === 'browser.containers.list' || request.tool === 'browser.containers.open') {
    // Firefox exposes this browser-specific permission; never attempt to emulate containers elsewhere.
    if (!browserApi?.runtime?.getBrowserInfo) throw new Error('当前浏览器不支持 Firefox Contextual Identities');
    const permissionList = request.tool === 'browser.containers.open'
      ? ['contextualIdentities', 'cookies'] : ['contextualIdentities'];
    if (!browserApi?.permissions?.contains) throw new Error('当前浏览器不支持扩展权限检查');
    const granted = await browserApi.permissions.contains({ permissions: permissionList });
    if (!granted && (!browserApi.permissions.request || !(await browserApi.permissions.request({ permissions: permissionList })))) {
      throw new Error('用户未授予 Firefox 容器所需权限');
    }
    if (!browserApi?.contextualIdentities?.query) throw new Error('当前 Firefox 版本或平台不提供容器身份 API');
    const identities = await listContextualIdentities(browserApi);
    if (request.tool === 'browser.containers.list') {
      return { summary: JSON.stringify(identities.map(({ name, color, icon }) => ({ name, color, icon }))) };
    }
    const identity = identities.find((item) => item.name.toLocaleLowerCase() === String(args.identityName).toLocaleLowerCase());
    if (!identity) throw new Error('找不到指定 Firefox 容器；请先列出容器并使用准确名称');
    const tab = await createTabInIdentity(String(args.url), identity.cookieStoreId, browserApi);
    return { summary: `已在 Firefox 容器“${identity.name}”中打开 ${String(args.url)}（标签页 ID：${(tab as any)?.id ?? 'unknown'}）` };
  }

  if (request.tool === 'webauthn.capability') {
    const capability = getWebAuthnCapability();
    return { summary: capability.available ? '当前扩展页面支持 WebAuthn Passkey API。' : `当前不可用：${capability.reason}` };
  }

  if (request.tool === 'webauthn.create' || request.tool === 'webauthn.get') {
    const options = args.options as Record<string, unknown>;
    const rpId = request.tool === 'webauthn.create'
      ? String((options.rp as Record<string, unknown>).id)
      : String(options.rpId);
    const operation = request.tool === 'webauthn.create' ? 'create' : 'get';
    // Start the credential operation directly in the approval click handler.
    const credentialPromise = operation === 'create'
      ? createExtensionPasskey(options)
      : getExtensionPasskey(options);
    const credential = await credentialPromise;
    const origin = getWebAuthnClientOrigin(credential);
    const artifact: AgentToolArtifact = {
      title: operation === 'create' ? 'Passkey 注册响应' : 'Passkey 认证响应',
      json: JSON.stringify({
        operation, rpId, origin,
        credential: serializeCredential(credential, operation),
      }, null, 2),
      origin,
    };
    return {
      summary: `${operation === 'create' ? 'Passkey 注册' : 'Passkey 认证'}已完成。RP ID：${rpId}；Origin：${origin || '无法解析'}。完整响应只显示在扩展界面，不会发送给模型；请提交给 relying-party 服务端验证。`,
      artifact,
    };
  }

  throw new Error('不支持的 Agent 工具');
}
