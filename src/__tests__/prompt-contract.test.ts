import { describe, expect, it } from 'vitest';
import { renderGlossaryBlock, TRANSLATION_CONTRACT } from '../entrypoints/service/prompt-contract';

describe('translation prompt - localized names and translatable vocabulary', () => {
  it('does not treat auto-extracted candidates as an instruction to preserve English', () => {
    const glossary = renderGlossaryBlock({
      document_terms: ['Blackthorne', 'Dutch', 'Erasmus', 'English', 'OpenAI', 'Portuguese', 'Spanish'],
    });

    expect(glossary).toContain('候选列表');
    expect(glossary).toContain('不是“必须保留英文”的命令');
    expect(glossary).toContain('国籍、族群、语言名称');
    expect(glossary).toContain('通行译名或自然音译');
    expect(TRANSLATION_CONTRACT).toContain('不要机械逐词对应成不自然的中文搭配');
  });
});
