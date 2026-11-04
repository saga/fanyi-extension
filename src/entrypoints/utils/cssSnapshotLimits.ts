/**
 * 单张样式表（含 @import 展开结果）的字节上限。
 *
 * 站点主样式表常见 500–800 KiB，例如 smithsonianmag 的打包 CSS 约 607 KiB。
 * 上限太小会把整张表丢弃，缓存页只剩无样式正文，只能依赖服务端 Reader 兜底。
 * 这里与 inlineStylesheets 的总预算对齐：单张用满时其余表由总预算挡下，
 * 快照不会无限膨胀。background 与 content script 共用此值，避免两处各自漂移。
 */
export const MAX_CSS_SHEET_BYTES = 1.5 * 1024 * 1024;
