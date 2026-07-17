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
 *   - 否则作为独立参数前置（例如传入 Error 对象时）。
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
 * 把 `[fanyi:level]` 拼到首参字符串前面；首参不是字符串则前置为独立参数。
 *
 * 之所以不总是用独立参数，是为了保持向后兼容现有测试：
 *   `expect(warn.mock.calls[0][0]).toContain('NodeMap mismatch')`
 * —— 拼到字符串里，'NodeMap mismatch' 仍然是首参的子串。
 */
function withPrefix(level: string, args: LogArgs): LogArgs {
  if (args.length > 0 && typeof args[0] === 'string') {
    return [`${PREFIX}:${level}] ${args[0]}`, ...args.slice(1)];
  }
  return [`${PREFIX}:${level}]`, ...args];
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
