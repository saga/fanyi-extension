import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DocumentReaderPage } from '../entrypoints/utils/document/pagination';
import type { DocumentSegment } from '../entrypoints/utils/document/types';
import {
  buildComparisonScopes,
  buildModelOptions,
  COMPARISON_MAX_SEGMENTS,
  CURRENT_PAGE_SCOPE_KEY,
} from '../entrypoints/document/modelComparisonOptions';

function segments(ids: string[]): DocumentSegment[] {
  return ids.map((id) => ({ id, text: 'text ' + id, kind: 'paragraph' } as DocumentSegment));
}

function page(id: string, title: string, ids: string[]): DocumentReaderPage {
  const items = segments(ids);
  return { id, title, sectionTitle: title, segments: items, charCount: items.length };
}

describe('三模型对比结果展示', () => {
  it('每个原文段落使用纵向表格，逐行展示原文和各模型译文', () => {
    const template = readFileSync(
      process.cwd() + '/src/entrypoints/document/DocumentModelComparison.vue', 'utf8',
    );
    expect(template).toContain('三模型初译对比');
    expect(template).toContain('class="comparison-table"');
    expect(template).toContain('<th scope="row">原文</th>');
    expect(template).toContain('<th scope="row">模型 A</th>');
    expect(template).toContain('<th scope="row">模型 B</th>');
    expect(template).toContain('<th scope="row">模型 C</th>');
    expect(template).toContain('v-if="activeComparison.modelC"');
    expect(template).not.toContain('comparison-columns');
    expect(template).toContain('font-size: 1.02rem');
    const readerCss = readFileSync(
      process.cwd() + '/src/entrypoints/document/documentReaderStyles.css', 'utf8',
    );
    expect(readerCss).toContain('max-width: 76rem');
  });

  it('A/B/C 默认均使用 Workbuddy，C 可关闭，且每个模型可分别选择思考方式和推理强度', () => {
    const template = readFileSync(
      process.cwd() + '/src/entrypoints/document/DocumentModelComparison.vue', 'utf8',
    );
    expect(template).toContain("modelA = ref<ModelChoice>({ provider: 'workbuddy'");
    expect(template).toContain("modelB = ref<ModelChoice>({ provider: 'workbuddy'");
    expect(template).toContain("modelC = ref<ModelChoice>({ provider: 'workbuddy'");
    expect(template).toContain('const thirdModelEnabled = ref(true)');
    expect(template).toContain('v-model="thirdModelEnabled"');
    expect(template).toContain('v-model="modelA.thinkingMode"');
    expect(template).toContain('v-model="modelB.thinkingMode"');
    expect(template).toContain('v-model="modelC.thinkingMode"');
    expect(template).toContain('v-model="modelA.effort"');
    expect(template).toContain('v-model="modelB.effort"');
    expect(template).toContain('v-model="modelC.effort"');
    expect(template).toContain('models: activeModelChoices.value');
  });
});

describe('双模型对比面板选项', () => {
  it('Workbuddy 下拉含 auto、目录模型，且保留 A/B 自定义标识', () => {
    expect(buildModelOptions([' claude-a ', 'claude-b', 'claude-a', ''], ['custom-a', 'auto']))
      .toEqual(['auto', 'claude-a', 'claude-b', 'custom-a']);
  });

  it('目录为空也保留 auto 与当前值，不会把已选模型悄悄改掉', () => {
    expect(buildModelOptions([], ['auto', 'legacy-model'])).toEqual(['auto', 'legacy-model']);
  });

  it('范围下拉默认当前页，并列出每个阅读页/章节的片段', () => {
    const options = buildComparisonScopes(
      [page('epub-0', '第一章', ['s1', 's2']), page('epub-1', '第二章', ['s3'])],
      segments(['s0']),
    );
    expect(options.map((option) => option.key)).toEqual([CURRENT_PAGE_SCOPE_KEY, 'epub-0', 'epub-1']);
    expect(options[0]!.segmentIds).toEqual(['s0']);
    expect(options[1]!.label).toContain('2 段');
    expect(options.every((option) => !option.disabled)).toBe(true);
  });

  it('EPUB 长章被切成多页时提供整章选项，并按 80 段上限禁用', () => {
    const ids = Array.from({ length: COMPARISON_MAX_SEGMENTS + 1 }, (_, i) => 's' + i);
    const first = page('epub-0:0', '第一章 · 1/2', ids.slice(0, 40));
    const second = page('epub-0:1', '第一章 · 2/2', ids.slice(40));
    first.sectionTitle = '第一章';
    second.sectionTitle = '第一章';
    const options = buildComparisonScopes([first, second], segments(['s0']));
    expect(options.map((option) => option.key)).toEqual([CURRENT_PAGE_SCOPE_KEY, 'chapter-0', 'epub-0:0', 'epub-0:1']);
    expect(options[1]!.label).toContain('整章：第一章');
    expect(options[1]!.segmentIds).toEqual(ids);
    expect(options[1]!.disabled).toBe(true);
    expect(options[2]!.disabled).toBe(false);
  });

  it('超过后端 80 段上限或空页的选项被禁用，不会等到提交才报错', () => {
    const options = buildComparisonScopes(
      [page('big', '长章', Array.from({ length: COMPARISON_MAX_SEGMENTS + 1 }, (_, i) => 's' + i)), page('empty', '空页', [])],
      segments(['s0']),
    );
    expect(options[1]!.disabled).toBe(true);
    expect(options[1]!.label).toContain('超过 80 段上限');
    expect(options[2]!.disabled).toBe(true);
    expect(options[0]!.disabled).toBe(false);
  });
});
