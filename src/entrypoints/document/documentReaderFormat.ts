/** 文档格式的展示名称（阅读页与恢复记录共用）。 */
export const FORMAT_LABEL: Record<string, string> = {
  txt: '纯文本',
  md: 'Markdown',
  html: 'HTML',
  srt: 'SRT 字幕',
  vtt: 'VTT 字幕',
  json: 'JSON',
  pdf: 'PDF',
  docx: 'Word',
  epub: 'EPUB',
};

export const BUILT_IN_USER_PROMPT_TEMPLATE = [
  '请翻译以下 JSON 数组中的每个对象。只翻译 text 字段，必须保留 id、顺序、段落边界和结构信息。',
  'contextPath、kind、level、marker 等字段是只读元数据，不能写入译文。只返回与输入 ID 一一对应的 JSON 译文，不要增加解释或额外字段。',
  '', 'JSON:', '', '{{CONTENT}}',
].join(String.fromCharCode(10));

export function languageFontClass(language: string, text: string): 'font-en' | 'font-zh' {
  const normalized = (language || 'auto').toLowerCase();
  if (normalized.startsWith('zh')) return 'font-zh';
  if (normalized.startsWith('en')) return 'font-en';
  if (normalized === 'auto') {
    // Use the Chinese font when CJK is a meaningful part of the segment, not for a lone
    // Chinese name embedded in an otherwise English paragraph.
    const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    return cjk > 0 && cjk >= latin * 0.25 ? 'font-zh' : 'font-en';
  }
  // This reader exposes separate English/Chinese typography; other scripts use the English fallback.
  return 'font-en';
}
