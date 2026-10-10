/**
 * 规范化文档翻译响应。
 * 只接纳当前批次预期 ID 对应的非空译文；未知 ID、格式错误、空文本及重复项均忽略，
 * 由调用方根据缺失 ID 决定重试或将批次标记为失败。
 */
export function normalizeDocumentBatchResult(
  entries: unknown,
  expectedIds: readonly string[],
): Map<string, string> {
  const expected = new Set(expectedIds);
  const result = new Map<string, string>();
  if (!Array.isArray(entries)) return result;

  for (const entry of entries as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const id: unknown = entry[0];
    const translated: unknown = entry[1];
    if (typeof id !== 'string' || !expected.has(id)) continue;
    if (typeof translated !== 'string' || !translated.trim()) continue;
    if (result.has(id)) continue;
    result.set(id, translated);
  }
  return result;
}

export function getMissingDocumentBatchIds(
  expectedIds: readonly string[],
  translations: ReadonlyMap<string, string>,
): string[] {
  return expectedIds.filter((id) => !translations.get(id)?.trim());
}
