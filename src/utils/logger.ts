/**
 * 统一日志门面（logger facade）
 *
 * 历史：18 个文件里散布 90+ 处 `console.log/warn/error`，生产环境也会输出，
 * 既影响性能（每次 console 调用都会触发 DevTools 序列化），也暴露内部逻辑。
 *
 * 本模块提供 4 个级别，行为：
 *   - debug  — 默认静默。开发模式（`import.meta.env.DEV`）或运行时
 *               `localStorage.fanyi-debug === '1'` / `window.__fanyiDebug === true`
 *               时开启。
 *   - info   — 始终输出。用于不敏感的诊断信息（如 [SessionSummary]）。
 *   - warn   — 始终输出，统一前缀 `[fanyi:warn]`。降级行为或可恢复错误。
 *   - error  — 始终输出，统一前缀 `[fanyi:error]`。实际失败。
 *
 * 前缀策略：
 *   - 如果首参是字符串，把 `[fanyi:level]` 拼到字符串前面，便于现有测试
 *     `expect(warn.mock.calls[0][0]).toContain('...')` 不被破坏。
 *   - 后续对象与 Error 参数先序列化成可读 JSON，确保 content script / background
 *     日志面板不把诊断内容显示为 `[object Object]`；Error 额外保留 message/stack/cause。
 *   - 字符串之外的第一个参数也以独立前缀参数开头，保持统一日志格式。
 *
 * 设计权衡：
 *   - 不替换 `console` 全局对象，避免污染页面 JS（content script 场景）。
 *   - 不引入 loglevel / debug 这类依赖，零运行时开销（debug 关闭时只是一次条件判断）。
 *   - 不在 logger 里发消息到 background（暂无远程日志收集需求，避免
 *     background 跟着被 log 触发死循环）。
 *
 * 使用方式：
 *   import { logger } from '@/utils/logger';
 *   logger.debug('[ContentScript] ...');
 *   logger.warn('...');
 *   logger.error('...', error);
 *
 * 运行时打开调试：
 *   - 浏览器 DevTools Console: localStorage.setItem('fanyi-debug', '1')
 *   - 或: window.__fanyiDebug = true  （不需 reload 立即生效）
 */

type LogArgs = unknown[];

const PREFIX = '[fanyi';

/**
 * 判断是否开启 debug 级别日志。
 *
 * 每次调用都重新检查（不缓存），方便用户在 DevTools 里热切换无需 reload。
 * localStorage 在某些页面（about:blank、CSP 严格的页）可能不可访问，要 try/catch。
 */
function isDebugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    if (typeof window !== 'undefined' && (window as { __fanyiDebug?: boolean }).__fanyiDebug === true) {
      return true;
    }
    if (typeof localStorage !== 'undefined' && localStorage.getItem('fanyi-debug') === '1') {
      return true;
    }
  } catch {
    // 某些环境下 localStorage 访问会抛错（如 sandboxed iframe），忽略
  }
  return false;
}

/**
 * DevTools differ in how they render objects passed through extension/content-script logs.
 * Serialize structured values explicitly so failures never collapse to "[object Object]".
 * Error properties are normally non-enumerable, so copy name/message/stack deliberately.
 */
function formatLogArg(value: unknown): unknown {
  if (value instanceof Error) {
    const cause = (value as Error & { cause?: unknown }).cause;
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: cause instanceof Error
        ? { name: cause.name, message: cause.message, stack: cause.stack }
        : cause,
    }, null, 2);
  }
  if (!value || typeof value !== 'object') return value;

  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, current: unknown) => {
      if (current instanceof Error) {
        return { name: current.name, message: current.message, stack: current.stack };
      }
      if (current && typeof current === 'object') {
        if (seen.has(current as object)) return '[Circular]';
        seen.add(current as object);
      }
      return current;
    }, 2);
    if (serialized == null) return Object.prototype.toString.call(value);
    return serialized.length > 12000
      ? serialized.slice(0, 12000) + '\n…[log object truncated at 12000 characters]'
      : serialized;
  } catch (error) {
    return '[unserializable object: ' + (error instanceof Error ? error.message : String(error)) + ']';
  }
}

/**
 * 把 `[fanyi:level]` 拼到首参字符串前面；首参不是字符串则前置独立前缀参数。
 * 保留既有测试和调用方依赖的前缀格式，后续参数统一先做可读序列化。
 */
function withPrefix(level: string, args: LogArgs): LogArgs {
  const formatted = args.map(formatLogArg);
  if (args.length > 0 && typeof args[0] === 'string') {
    return [`${PREFIX}:${level}] ${args[0]}`, ...formatted.slice(1)];
  }
  return [`${PREFIX}:${level}]`, ...formatted];
}

export const logger = {
  debug(...args: LogArgs): void {
    if (!isDebugEnabled()) return;
    console.log(...withPrefix('debug', args));
  },

  info(...args: LogArgs): void {
    console.log(...withPrefix('info', args));
  },

  warn(...args: LogArgs): void {
    console.warn(...withPrefix('warn', args));
  },

  error(...args: LogArgs): void {
    console.error(...withPrefix('error', args));
  },
};

export type Logger = typeof logger;
