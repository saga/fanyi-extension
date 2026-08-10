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
}

/** 中英文通用句子计数：以 . ! ? ; 及中文 。！？； 与换行切分，过滤空/纯符号片段。 */
export function countSentences(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/[\n\r]+/g, '。');
  const parts = normalized.split(/[.!?;。！？；]+/);
  let count = 0;
  for (const raw of parts) {
    const t = raw.trim();
    if (t.length === 0) continue;
    if (!/[一-鿿a-zA-Z]/.test(t)) continue;
    count++;
  }
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
    if (sentenceRatio < minSentenceRatio) {
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
