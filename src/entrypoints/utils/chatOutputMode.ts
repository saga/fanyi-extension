/**
 * Chat output-format inference.
 *
 * Structured JSON is enabled only when the current user request asks for a
 * machine-readable JSON result. Ordinary conversation remains natural language.
 */
export function shouldUseJsonMode(question: string): boolean {
  const value = question.trim();
  if (!value) return false;
  if (/(?:不要|不需要|无需|别|禁止|without|do not|don't|not).{0,12}(?:json|结构化)/i.test(value)) return false;
  return /(?:用|以|按|输出|返回|生成|提供|给出|整理成|转换成|转换为|转成|format(?:\s+as)?|return(?:\s+as)?|respond(?:\s+in)?|output(?:\s+as)?|serialize|convert(?:\s+to)?).{0,20}(?:json|结构化(?:数据|结果|输出)?|machine[- ]readable)|(?:json|结构化(?:数据|结果|输出)?|machine[- ]readable).{0,16}(?:格式|对象|数组|输出|返回|format|object|array)/i.test(value);
}
