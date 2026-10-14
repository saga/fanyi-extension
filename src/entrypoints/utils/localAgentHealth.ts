/**
 * 检测 Vocal Saga 本机 Agent 服务是否真正启动。
 *
 * 使用无须 Token 的 /health，而不是 /v1/models：
 * - /health 只返回服务存活信息，不会因用户配置了 LOCAL_AGENT_TOKEN 而误判为离线；
 * - 校验 service 标识，避免把端口上其他恰好返回 200 的服务误认为本服务；
 * - 请求设置短超时，不阻塞扩展弹窗；
 * - 仅用于 UI 可用性提示，翻译请求仍由原有路径处理和报错。
 */
export async function isLocalAgentServiceAvailable(
  baseUrl: string,
  timeoutMs = 1200,
): Promise<boolean> {
  const value = baseUrl.trim();
  if (!value) return false;

  let healthUrl: URL;
  try {
    healthUrl = new URL('/health', value);
    if (healthUrl.protocol !== 'http:' && healthUrl.protocol !== 'https:') return false;
  } catch {
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    const response = await fetch(healthUrl.toString(), {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return false;

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

    const health = payload as { ok?: unknown; service?: unknown };
    return health.ok === true && health.service === 'vocal-saga-local-agent';
  } catch {
    // 服务未启动、超时、CORS 或 JSON 响应错误均视为当前不可用。
    return false;
  } finally {
    clearTimeout(timer);
  }
}
