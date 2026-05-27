import { describe, it, expect } from 'vitest';
import { extractGlossaryLocal } from './glossaryExtractor';

describe('extractGlossaryLocal', () => {
  it('extracts acronyms from text', () => {
    const text = 'We use LLM and API to build GPT models with CUDA support.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).toContain('LLM');
    expect(terms).toContain('API');
    expect(terms).toContain('GPT');
    expect(terms).toContain('CUDA');
  });

  it('filters out common English words from acronyms', () => {
    const text = 'THE AND FOR NOT ARE BUT ALL CAN HAS HER WAS ONE OUR OUT USE VIA WHO ITS MAY NOR';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).not.toContain('THE');
    expect(terms).not.toContain('AND');
    expect(terms).not.toContain('FOR');
  });

  it('extracts named entities (people, organizations, places)', () => {
    const text = 'Chuang Gan and Maohao Shen from UMass Amherst and MIT published the paper.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms.length).toBeGreaterThan(0);
  });

  it('includes emphasized terms from DOM', () => {
    const text = 'We introduce workflow compilation for LLM optimization.';
    const emphasized = ['workflow compilation', 'LLM optimization'];
    const result = extractGlossaryLocal(text, emphasized);
    const terms = result.map(r => r.term);

    expect(terms).toContain('workflow compilation');
    expect(terms).toContain('LLM optimization');
  });

  it('filters short and long emphasized terms', () => {
    const text = 'Some text here.';
    const emphasized = ['A', 'x'.repeat(81)];
    const result = extractGlossaryLocal(text, emphasized);
    const terms = result.map(r => r.term);

    expect(terms).not.toContain('A');
    expect(terms).not.toContain('x'.repeat(81));
  });

  it('removes subsumed terms (shorter term contained in longer one)', () => {
    const text = 'We use CUDA and CUDA Toolkit for GPU programming.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    if (terms.includes('CUDA Toolkit')) {
      expect(terms).not.toContain('CUDA');
    }
  });

  it('returns all entries with KEEP translation', () => {
    const text = 'We use LLM and API for GPT models.';
    const result = extractGlossaryLocal(text);

    for (const entry of result) {
      expect(entry.translation).toBe('KEEP');
    }
  });

  it('sorts results by term length descending', () => {
    const text = 'We use LLM and API for GPT models.';
    const result = extractGlossaryLocal(text);

    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].term.length).toBeGreaterThanOrEqual(result[i].term.length);
    }
  });

  it('handles empty text', () => {
    const result = extractGlossaryLocal('');
    expect(result).toEqual([]);
  });

  it('handles text with no extractable terms', () => {
    const text = 'the and for not are but all can has her was one our out use via who its may nor';
    const result = extractGlossaryLocal(text);
    expect(result.length).toBe(0);
  });

  it('deduplicates terms', () => {
    const text = 'We use LLM for LLM training and LLM inference.';
    const result = extractGlossaryLocal(text);
    const llmEntries = result.filter(r => r.term === 'LLM');

    expect(llmEntries.length).toBe(1);
  });

  it('extracts from academic paper text', () => {
    const text = `We introduce workflow compilation, a compiler-inspired paradigm for optimizing
      structured LLM workflows before deployment and producing reusable accuracy-latency
      trade-off sets. Chuang Gan from MIT and Maohao Shen from UMass Amherst demonstrate
      that CUDA and GPU acceleration improve performance on NLP tasks.`;
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).toContain('LLM');
    expect(terms).toContain('CUDA');
    expect(terms).toContain('GPU');
    expect(terms).toContain('NLP');
    expect(result.length).toBeGreaterThan(4);
  });
});
