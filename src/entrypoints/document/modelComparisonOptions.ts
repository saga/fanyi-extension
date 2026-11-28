/**
 * 多模型对比面板的选项构造。
 *
 * 后端只接受来自当前原文版本、且不超过单次上限的 segment ID，
 * 所以「选章节」在前端只是把阅读页/章节的片段集合映射成 ID 列表。
 */
export const COMPARISON_MAX_SEGMENTS = 80;
export const CURRENT_PAGE_SCOPE_KEY = '__current__';

export interface ComparisonScopeOption {
  key: string;
  label: string;
  segmentIds: string[];
  segmentCount: number;
  disabled: boolean;
}

type ScopePage = { id: string; title: string; sectionTitle?: string; segments: Array<{ id: string }> };

/**
 * Workbuddy 用本机 /api/codebuddy/models 的下拉；auto 始终可选。
 * 当前值不在目录里时补进去，避免历史记录/自定义模型被下拉悄悄改掉。
 */
export function buildModelOptions(catalogIds: string[], current: string | string[]): string[] {
  const values = ['auto'];
  const seen = new Set(values);
  for (const raw of catalogIds) {
    const value = String(raw || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  const customs = Array.isArray(current) ? current : [current];
  for (const raw of customs) {
    const custom = String(raw || '').trim();
    if (custom && !seen.has(custom)) values.push(custom);
  }
  return values;
}

/**
 * 范围下拉：默认「当前页」，其余为阅读器分页（EPUB 分页即按章节切分）。
 * 超过后端上限或空页的选项禁用，避免点下去才报错。
 */
export function buildComparisonScopes(
  pages: ScopePage[],
  currentSegments: Array<{ id: string }>,
  maxSegments = COMPARISON_MAX_SEGMENTS,
): ComparisonScopeOption[] {
  const describe = (label: string, ids: string[]): ComparisonScopeOption => ({
    key: '',
    label: ids.length > maxSegments
      ? label + '（' + ids.length + ' 段，超过 ' + maxSegments + ' 段上限）'
      : label + '（' + ids.length + ' 段）',
    segmentIds: ids,
    segmentCount: ids.length,
    disabled: ids.length === 0 || ids.length > maxSegments,
  });
  const current = describe('当前页', currentSegments.map((segment) => segment.id));
  current.key = CURRENT_PAGE_SCOPE_KEY;
  // EPUB 长章会被切成多个阅读页；同章节的页额外提供「整章」选项，超过上限时禁用。
  const chapters = new Map<string, { title: string; pages: ScopePage[] }>();
  for (const item of pages) {
    const title = item.sectionTitle || item.title;
    const group = chapters.get(title) || { title, pages: [] };
    group.pages.push(item);
    chapters.set(title, group);
  }
  const chapterOptions = Array.from(chapters.values())
    .filter((group) => group.pages.length > 1)
    .map((group, index) => {
      const option = describe('整章：' + group.title, group.pages.flatMap((item) => item.segments.map((segment) => segment.id)));
      option.key = 'chapter-' + index;
      return option;
    });
  return [current, ...chapterOptions, ...pages.map((page) => {
    const option = describe(page.title, page.segments.map((segment) => segment.id));
    option.key = page.id;
    return option;
  })];
}
