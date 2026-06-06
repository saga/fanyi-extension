import { describe, it, expect } from 'vitest';
import { filterRelevantGlossary } from '../entrypoints/service/deepseek';

describe('filterRelevantGlossary', () => {
  it('should return undefined when glossary is empty', () => {
    const blocks = [{ id: 'b1', text: 'Hello world' }];
    expect(filterRelevantGlossary(blocks, [])).toBeUndefined();
    expect(filterRelevantGlossary(blocks, undefined)).toBeUndefined();
  });

  it('should filter terms that appear in chunk text', () => {
    const blocks = [
      { id: 'b1', text: 'React is a JavaScript library' },
      { id: 'b2', text: 'Used for building user interfaces' },
    ];
    const glossary = [
      { term: 'React', translation: 'React' },
      { term: 'Angular', translation: 'Angular' },
      { term: 'JavaScript', translation: 'JavaScript' },
      { term: 'Python', translation: 'Python' },
    ];

    const result = filterRelevantGlossary(blocks, glossary);
    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
    expect(result!.map((g) => g.term)).toContain('React');
    expect(result!.map((g) => g.term)).toContain('JavaScript');
    expect(result!.map((g) => g.term)).not.toContain('Angular');
    expect(result!.map((g) => g.term)).not.toContain('Python');
  });

  it('should be case-insensitive', () => {
    const blocks = [{ id: 'b1', text: 'REACT and javascript' }];
    const glossary = [
      { term: 'react', translation: 'React' },
      { term: 'JavaScript', translation: 'JavaScript' },
    ];

    const result = filterRelevantGlossary(blocks, glossary);
    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
  });

  it('should return undefined when no terms match', () => {
    const blocks = [{ id: 'b1', text: 'Simple text without tech terms' }];
    const glossary = [
      { term: 'Kubernetes', translation: 'Kubernetes' },
      { term: 'Docker', translation: 'Docker' },
    ];

    const result = filterRelevantGlossary(blocks, glossary);
    expect(result).toBeUndefined();
  });

  it('should handle multi-word terms', () => {
    const blocks = [{ id: 'b1', text: 'Machine learning is powerful' }];
    const glossary = [
      { term: 'Machine Learning', translation: '机器学习' },
      { term: 'Deep Learning', translation: '深度学习' },
    ];

    const result = filterRelevantGlossary(blocks, glossary);
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result![0].term).toBe('Machine Learning');
  });

  it('should handle partial matches correctly', () => {
    // "cat" should not match "category"
    const blocks = [{ id: 'b1', text: 'This is a category' }];
    const glossary = [
      { term: 'cat', translation: '猫' },
      { term: 'category', translation: '类别' },
    ];

    const result = filterRelevantGlossary(blocks, glossary);
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result![0].term).toBe('category');
  });

  it('should handle all terms matching', () => {
    const blocks = [{ id: 'b1', text: 'React and Angular are frameworks' }];
    const glossary = [
      { term: 'React', translation: 'React' },
      { term: 'Angular', translation: 'Angular' },
    ];

    const result = filterRelevantGlossary(blocks, glossary);
    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
  });
});
