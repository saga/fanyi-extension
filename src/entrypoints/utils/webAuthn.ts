export interface WebAuthnCapability { available: boolean; reason?: string }
export function getWebAuthnCapability(
  credentials: CredentialsContainer | undefined = typeof navigator === 'undefined' ? undefined : navigator.credentials,
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): WebAuthnCapability {
  if (!credentials?.create || !credentials?.get) return { available: false, reason: '当前扩展页面没有可用的 WebAuthn Credentials API' };
  const firefoxVersion = Number(userAgent.match(/Firefox\\/(\\d+)/i)?.[1] ?? 0);
  const chromiumVersion = Number(userAgent.match(/(?:Chrome|Chromium)\\/(\\d+)/i)?.[1] ?? 0);
  if (firefoxVersion > 0 && firefoxVersion < 150) return { available: false, reason: '扩展 RP ID WebAuthn 需要 Firefox 150 或更高版本' };
  if (chromiumVersion > 0 && chromiumVersion < 122) return { available: false, reason: '扩展 RP ID WebAuthn 需要 Chrome 122 或更高版本' };
  return { available: true };
}
function fromBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function decodeCreationOptions(input: any): PublicKeyCredentialCreationOptions {
  const options = { ...input, challenge: typeof input.challenge === 'string' ? fromBase64(input.challenge) : input.challenge, user: { ...input.user } };
  if (typeof options.user.id === 'string') options.user.id = fromBase64(options.user.id);
  if (options.excludeCredentials) options.excludeCredentials = options.excludeCredentials.map((item: any) => ({ ...item, id: typeof item.id === 'string' ? fromBase64(item.id) : item.id }));
  return options;
}
function decodeRequestOptions(input: any): PublicKeyCredentialRequestOptions {
  const options = { ...input, challenge: typeof input.challenge === 'string' ? fromBase64(input.challenge) : input.challenge };
  if (options.allowCredentials) options.allowCredentials = options.allowCredentials.map((item: any) => ({ ...item, id: typeof item.id === 'string' ? fromBase64(item.id) : item.id }));
  return options;
}
/** Run from an extension document, not a background worker. Host permissions must cover RP ID. */
export async function createExtensionPasskey(options: any, credentials: CredentialsContainer = navigator.credentials): Promise<PublicKeyCredential> {
  const capability = getWebAuthnCapability(credentials);
  if (!capability.available) throw new Error(capability.reason);
  const result = await credentials.create({ publicKey: decodeCreationOptions(options) });
  if (!(result instanceof PublicKeyCredential)) throw new Error('Passkey registration cancelled or returned no credential');
  return result;
}
export async function getExtensionPasskey(options: any, credentials: CredentialsContainer = navigator.credentials): Promise<PublicKeyCredential> {
  const capability = getWebAuthnCapability(credentials);
  if (!capability.available) throw new Error(capability.reason);
  const result = await credentials.get({ publicKey: decodeRequestOptions(options) });
  if (!(result instanceof PublicKeyCredential)) throw new Error('Passkey authentication cancelled or returned no credential');
  return result;
}
export function getWebAuthnClientOrigin(credential: PublicKeyCredential): string | null {
  try { const data = JSON.parse(new TextDecoder().decode(credential.response.clientDataJSON)); return typeof data.origin === 'string' ? data.origin : null; }
  catch { return null; }
}
