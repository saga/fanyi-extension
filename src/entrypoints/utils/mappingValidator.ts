/**
 * 翻译映射校验（mapping validation）— fanyi-extension 端
 * =============================================================================
 * 与 vocal-saga `lib/translate/mappingValidator.ts` 逻辑一致（双仓各自自包含，
 * 避免跨仓依赖）。用于扩展端的本地翻译路径，以及服务端回填路径
 * （两者最终都走 applyBlockTranslation），检测 block 的原文/译文信息量是否严重
 * 不匹配，从而发现 block id 错配（标题拿到正文译文等）。
 *
 * 为什么需要：服务端校验只覆盖走 /fanyi/page 的请求；本地翻译不经过服务端，
 * 同样的按 id 配对逻辑也存在错配风险，必须客户端自校验。
 *
 * 信号：见 vocal-saga 端注释。默认 log-only，不改翻译结果。
 * 句子计数不把 `;`、缩写内的句点（e.g. / i.e. / U.S.）、以及「句点+空格+小写」
 * 当作句末，否则单个英文列表项会被数成 3 句、中文译文只有 1 句而被误判为错配。
 */

export interface MappingVerdict {
  origChars: number;
  transChars: number;
  origSentences: number;
  transSentences: number;
  charRatio: number;
  sentenceRatio: number;
  suspect: boolean;
  reasons: string[];
}

export interface MappingOptions {
  maxCharRatio?: number;
  minCharRatio?: number;
  maxSentenceRatio?: number;
  minSentenceRatio?: number;
  minAbsoluteChars?: number;
  minOrigCharsForShortCheck?: number;
  /** 启用「句子数骤减」判定所需的原文最小句数，默认 4。 */
  minOrigSentencesForCollapse?: number;
}

/** 句末标点：中英文句号/叹号/问号。分号属从句级标点，不切分句子。 */
const SENTENCE_END_CHARS = new Set(['。', '！', '？', '!', '?']);

/** 句点后面允许出现的「收尾」字符；其余字符（字母/数字）说明句点是词内点。 */
const TRAILING_CHARS = /[\s"'”’)\]】]/;

/** 常见缩写（小写比较）：其后的句点不是句末。 */
const ABBREVIATIONS = new Set([
  'e.g.',
  'i.e.',
  'etc.',
  'vs.',
  'cf.',
  'ca.',
  'approx.',
  'al.',
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'st.',
  'fig.',
  'no.',
  'vol.',
  'u.s.',
  'u.k.',
  'a.k.a.',
  'p.s.',
]);

/** `beforeDot` 是否以已知缩写结尾（例如 "...(e.g." 里的 "e.g."）。 */
function endsWithAbbreviation(beforeDot: string): boolean {
  const token = beforeDot.match(/([A-Za-z][A-Za-z.]*\.)$/)?.[1];
  return token !== undefined && ABBREVIATIONS.has(token.toLowerCase());
}

/** 判断 index 处的 `.` 是否为句末（而非 3.5 / node.js / e.g. 这类词内点）。 */
function isPeriodBoundary(text: string, index: number): boolean {
  const next = text[index + 1];
  // 句点后直接跟字母/数字 → 词内点
  if (next !== undefined && !TRAILING_CHARS.test(next)) return false;
  // 已知缩写 → 不是句末
  if (endsWithAbbreviation(text.slice(0, index + 1))) return false;
  // 句点后是空格 + 小写字母 → 同一句的延续（"e.g. memory" / "wait... and then"）
  const after = text.slice(index + 1).replace(/^[\s"'”’)\]】]+/, '')[0];
  if (after !== undefined && /[a-z]/.test(after)) return false;
  return true;
}

/**
 * 中英文通用句子计数。
 *
 * 切分规则：`。！？!?` 恒为句末；`.` 仅在「后面不是词内字符、不是已知缩写、
 * 且后面首个实字符不是小写字母」时算句末；换行视为段落分隔（按句末处理）。
 * 过滤空片段与纯符号/数字片段（不含字母或汉字）。
 */
export function countSentences(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/[\n\r]+/g, '。');

  let count = 0;
  let start = 0;
  const flush = (end: number) => {
    const piece = normalized.slice(start, end).trim();
    start = end;
    if (piece.length === 0) return;
    if (!/[一-鿿a-zA-Z]/.test(piece)) return;
    count++;
  };

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charAt(i);
    if (SENTENCE_END_CHARS.has(ch) || (ch === '.' && isPeriodBoundary(normalized, i))) {
      flush(i + 1);
    }
  }
  flush(normalized.length);

  return count;
}

export function validateBlockMapping(
  original: string,
  translated: string,
  opts: MappingOptions = {}
): MappingVerdict {
  const maxCharRatio = opts.maxCharRatio ?? 3.5;
  const minCharRatio = opts.minCharRatio ?? 0.2;
  const maxSentenceRatio = opts.maxSentenceRatio ?? 2.5;
  const minSentenceRatio = opts.minSentenceRatio ?? 0.34;
  const minAbs = opts.minAbsoluteChars ?? 25;
  const minOrigForShort = opts.minOrigCharsForShortCheck ?? 40;
  const minOrigForCollapse = opts.minOrigSentencesForCollapse ?? 4;

  const origChars = (original || '').replace(/\s/g, '').length;
  const transChars = (translated || '').replace(/\s/g, '').length;
  const origSentences = countSentences(original || '');
  const transSentences = countSentences(translated || '');

  const charRatio =
    origChars === 0 ? (transChars === 0 ? 1 : Infinity) : transChars / origChars;
  const sentenceRatio =
    origSentences === 0
      ? transSentences === 0
        ? 1
        : Infinity
      : transSentences / origSentences;

  const reasons: string[] = [];
  const absDiff = Math.abs(transChars - origChars);

  if (origChars === 0 && transChars > 0) {
    reasons.push('原文为空却有译文');
  }

  if (absDiff >= minAbs && origChars > 0) {
    if (charRatio > maxCharRatio) {
      reasons.push(`译文过长：字符比 ${charRatio.toFixed(2)} > ${maxCharRatio}`);
    }
    if (origChars > minOrigForShort && charRatio < minCharRatio) {
      reasons.push(`译文过短：字符比 ${charRatio.toFixed(2)} < ${minCharRatio}`);
    }
  }

  if (origSentences >= 1 && transSentences >= 1) {
    if (sentenceRatio > maxSentenceRatio) {
      reasons.push(`句子数激增：比 ${sentenceRatio.toFixed(2)} > ${maxSentenceRatio}`);
    }
    // 中文把几个英文短句并成一句是常态，只有原文句数足够多时「骤减」才有区分度：
    // 3 句→1 句（比 0.33）刚好压在阈值下，属于正常合并，不告警。
    if (sentenceRatio < minSentenceRatio && origSentences >= minOrigForCollapse) {
      reasons.push(`句子数骤减：比 ${sentenceRatio.toFixed(2)} < ${minSentenceRatio}`);
    }
  }

  return {
    origChars,
    transChars,
    origSentences,
    transSentences,
    charRatio,
    sentenceRatio,
    suspect: reasons.length > 0,
    reasons,
  };
}
