/**
 * 单次翻译会话标识。
 *
 * 扩展端每发起一次「整页翻译」就轮换一个新的 sessionId，
 * 在本次翻译的 check(查缓存) 与 page(翻译) 两次请求之间共享，
 * 用于把「一次翻译从发起 → 服务端处理 → 报错」整条链路在日志里关联起来
 * （例如定位 Firefox Android 翻译失败为何与 Chrome 不同）。
 *
 * 服务端（vocal-saga）会从 `X-Session-Id` 请求头（或 POST body 的
 * `sessionId` 兜底）读取该值，并打进相关日志行与 500 错误体。
 */

let currentSessionId: string | null = null;

function generateId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // 退化方案：随机 hex（非加密强度，仅供日志关联）
  }
  return (
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * 轮换一个新的 sessionId（每次发起翻译时调用）。
 * 返回新生成的 id，确保本次翻译的 check 与 page 请求共享同一 id。
 */
export function rotateSessionId(): string {
  currentSessionId = generateId();
  return currentSessionId;
}

/**
 * 取得当前会话 sessionId；若尚未轮换则惰性生成一个（向后兼容老流程）。
 */
export function getSessionId(): string {
  if (!currentSessionId) {
    currentSessionId = generateId();
  }
  return currentSessionId;
}
