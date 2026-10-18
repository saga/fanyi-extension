import type { ParsedDocument } from '@/entrypoints/utils/document/types';

export function buildDocumentAgentSessionId(document: ParsedDocument, fileName: string): string {
  let firstHash = 0x811c9dc5;
  let secondHash = 0x9e3779b9;
  const feed = (value: string) => {
    // Feed fields incrementally instead of joining an entire PDF/EPUB into another large string.
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      firstHash = Math.imul(firstHash ^ code, 0x01000193);
      secondHash = Math.imul(secondHash ^ code, 0x85ebca6b);
    }
    // Field boundary prevents ambiguity between concatenations such as ["ab", "c"] and ["a", "bc"].
    firstHash = Math.imul(firstHash ^ 0, 0x01000193);
    secondHash = Math.imul(secondHash ^ 0, 0x85ebca6b);
  };
  for (const value of [
    fileName, document.title, document.format,
    String(document.meta.segmentCount), String(document.meta.charCount),
  ]) feed(value);
  // Hash all source segments so edits anywhere in the same-length book start a clean session.
  for (const segment of document.segments) {
    feed(segment.id);
    feed(segment.text);
  }
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');
  return 'doc-' + hex(firstHash) + hex(secondHash);
}
