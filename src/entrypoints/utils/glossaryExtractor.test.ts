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

  it('filters out MUST DOER VS and other false-positive acronyms', () => {
    const text = 'You MUST be a DOER not a VS Code user. GET SET PUT LET SEE SAY.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).not.toContain('MUST');
    expect(terms).not.toContain('DOER');
    expect(terms).not.toContain('VS');
    expect(terms).not.toContain('GET');
    expect(terms).not.toContain('SET');
  });

  it('strips trailing punctuation from named entities', () => {
    const text = 'Brady went to Squad: and used TUI, for the project.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    for (const term of terms) {
      expect(term).not.toMatch(/[,;:.!?]$/);
      expect(term).not.toMatch(/^[,;:.!?]/);
    }
  });

  it('extracts recurring noun phrases by frequency', () => {
    const text = 'We use Playwright for testing. Playwright runs end-to-end tests. The Playwright framework is great. Playwright supports Chrome.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).toContain('Playwright');
  });

  it('filters out stopwords from frequent terms', () => {
    const text = 'The system works. That is clear. Then we proceed. When ready, we go. You can see Code here. Prompt is important. Work is done.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).not.toContain('The');
    expect(terms).not.toContain('That');
    expect(terms).not.toContain('Then');
    expect(terms).not.toContain('When');
    expect(terms).not.toContain('You');
  });

  it('filters out pure-stopword noun phrases', () => {
    const text = 'The way is long. The way is hard. The way is clear. The way is good.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).not.toContain('The way');
  });

  it('keeps noun phrases with non-stopword components', () => {
    const text = 'The context window is large. Context window matters. A context window defines limits. The context window expands.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms.some(t => t.toLowerCase().includes('context window'))).toBe(true);
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

  it('does not extract common words like time year people as glossary terms', () => {
    const text = 'Time passes quickly. Year after year. People change. The time has come. Many people agree. Next year will be better.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).not.toContain('Time');
    expect(terms).not.toContain('Year');
    expect(terms).not.toContain('People');
  });

  it('extracts technical terms that repeat', () => {
    const text = 'The token billing model uses tokens. Token billing is expensive. Token billing requires monitoring. Token billing affects costs.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms.some(t => t.toLowerCase().includes('token billing'))).toBe(true);
  });
});
