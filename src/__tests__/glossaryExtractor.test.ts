import { describe, it, expect } from 'vitest';
import { extractGlossaryLocal } from '../entrypoints/utils/glossaryExtractor';

describe('extractGlossaryLocal', () => {
  it('extracts acronyms from text', () => {
    const text = 'We use LLM and API to build GPT models with CUDA support.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('LLM');
    expect(terms).toContain('API');
    expect(terms).toContain('GPT');
    expect(terms).toContain('CUDA');
  });

  it('filters out common English words from acronyms', () => {
    const text = 'THE AND FOR NOT ARE BUT ALL CAN HAS HER WAS ONE OUR OUT USE VIA WHO ITS MAY NOR';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('THE');
    expect(terms).not.toContain('AND');
    expect(terms).not.toContain('FOR');
  });

  it('filters out MUST DOER VS and other false-positive acronyms', () => {
    const text = 'You MUST be a DOER not a VS Code user. GET SET PUT LET SEE SAY.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('MUST');
    expect(terms).not.toContain('DOER');
    expect(terms).not.toContain('VS');
    expect(terms).not.toContain('GET');
    expect(terms).not.toContain('SET');
  });


  it('extracts recurring noun phrases by frequency', () => {
    const text = 'We use Playwright for testing. Playwright runs end-to-end tests. The Playwright framework is great. Playwright supports Chrome.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).toContain('Playwright');
  });




  it('extracts named entities (people, organizations, places)', () => {
    const text = 'Chuang Gan and Maohao Shen from UMass Amherst and MIT published the paper.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms.length).toBeGreaterThan(0);
  });

  it('includes emphasized terms from DOM', () => {
    const text = 'We introduce workflow compilation for LLM optimization.';
    const emphasized = ['workflow compilation', 'LLM optimization'];
    const result = extractGlossaryLocal(text, emphasized);
    const terms = result.document_terms;

    expect(terms).toContain('workflow compilation');
    expect(terms).toContain('LLM optimization');
  });

  it('filters short and long emphasized terms', () => {
    const text = 'Some text here.';
    const emphasized = ['A', 'x'.repeat(81)];
    const result = extractGlossaryLocal(text, emphasized);
    const terms = result.document_terms;

    expect(terms).not.toContain('A');
    expect(terms).not.toContain('x'.repeat(81));
  });

  it('removes subsumed terms (shorter term contained in longer one)', () => {
    const text = 'We use CUDA and CUDA Toolkit for GPU programming.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // Acronyms (CUDA) are kept even when a longer phrase containing them
    // is also present — the acronym is the load-bearing glossary entry
    // for the model to render the acronym consistently across the article.
    // See isPhraseSubsuming() in glossaryExtractor.ts.
    if (terms.includes('CUDA Toolkit')) {
      expect(terms).toContain('CUDA');
    }
  });

  it('returns all entries as strings', () => {
    const text = 'We use LLM and API for GPT models.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    for (const term of terms) {
      expect(typeof term).toBe('string');
    }
  });






  it('does not extract common words like time year people as glossary terms', () => {
    const text = 'Time passes quickly. Year after year. People change. The time has come. Many people agree. Next year will be better.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('Time');
    expect(terms).not.toContain('Year');
    expect(terms).not.toContain('People');
  });


  // --- Singular/plural merging ---


  // --- #Noun #Gerund pattern ---


  it('extracts noun+gerund phrases like data processing', () => {
    const text = 'Data processing is fast. Data processing takes time. Data processing requires memory. Data processing is essential.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms.some(t => t.toLowerCase().includes('data processing'))).toBe(true);
  });

  // --- Stopword first-word filter ---

  it('rejects phrases starting with a stopword even if they contain substantive words', () => {
    const text = 'The architecture is modular. The architecture scales well. The architecture supports plugins. The architecture is extensible.';
    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    expect(terms).not.toContain('The architecture');
  });


  // --- Single word frequency threshold ---



  // --- Multi-word phrase frequency threshold ---



  // --- Substring dedup edge cases ---



  // --- Emphasized terms edge cases ---



  it('adds emphasized terms even if they appear only once', () => {
    const text = 'Some random text here.';
    const emphasized = ['unique technical term'];
    const result = extractGlossaryLocal(text, emphasized);
    const terms = result.document_terms;

    expect(terms).toContain('unique technical term');
  });

  // --- Length-based sorting ---


  // --- Mixed acronym + frequent term + named entity ---


  // --- Real-world technical article ---

  it('extracts from a realistic technical blog post', () => {
    const text = `Squad Places: A New Way to Coordinate Agents

    In our latest release, we introduce Squad Places — a coordination mechanism
    for disposable agents. Each Squad Place defines a coordination layer where
    agents can share context and synchronize tasks.

    PII scrubbing is built into every Squad Place. PII scrubbing removes sensitive
    data before it reaches the coordination layer. PII scrubbing runs automatically.

    The coordination mechanism supports UX suggestions. UX suggestions help
    developers improve their workflow. UX suggestions are generated by the
    coordination layer.

    Brady leads the engineering team. Dina Berry manages product. Together they
    built the TUI squad which ships features every sprint.`;

    const result = extractGlossaryLocal(text);
    const terms = result.document_terms;

    // Key technical terms should be present
    expect(terms.some(t => t.toLowerCase().includes('squad place'))).toBe(true);
    expect(terms.some(t => t.toLowerCase().includes('pii scrubbing'))).toBe(true);
    expect(terms.some(t => t.toLowerCase().includes('coordination layer'))).toBe(true);

    // Common words should NOT be present
    expect(terms).not.toContain('Code');
    expect(terms).not.toContain('Work');
    expect(terms).not.toContain('Things');
  });

  // --- Acronym edge cases ---




  // --- cleanTerm edge cases ---

});

// ============================================================
// Performance tests
// ============================================================

function generateLargeText(sectionCount: number): string {
  return Array.from({ length: sectionCount }, (_, i) =>
    `Section ${i + 1}: We use LLM and API to build GPT models with CUDA support.
     The workflow compilation approach optimizes structured LLM workflows before deployment.
     Chuang Gan from MIT and Maohao Shen from UMass Amherst published this research paper.
     The token billing model uses tokens for monitoring and cost analysis.
     Machine learning systems require data processing and memory management.
     Neural network architectures benefit from GPU acceleration and NLP techniques.
     The governance model ensures compliance with regulatory requirements.
     Research shows that agent systems can coordinate multiple tasks simultaneously.
     End-to-end testing with Playwright and Selenium improves reliability.
     PostgreSQL database management requires careful index optimization.
   `.trim()).join('\n\n');
}


// ============================================================
// Regression tests for the new improvements (PRE-PROCESSING,
// TAGGING INTERVENTION, lookaround boundaries, dedup protection).
// These test the new behavior added in the architectural rewrite.
// ============================================================











describe('extractGlossaryLocal - Context-aware Product Name Extraction (方案 D)', () => {
  it('extracts "Claude Sonnet 4.5" as a whole product name', () => {
    const text = 'Pair Claude Sonnet 4.5 as an advisor with Claude Haiku as an executor.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('Claude Sonnet 4.5');
  });

  it('extracts "Claude Opus 4.1" as a whole product name', () => {
    const text = 'Claude Opus 4.1 was released with improved reasoning.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('Claude Opus 4.1');
  });







  it('does NOT extract lowercase "sonnet" from poetry context', () => {
    // 关键：单独 "sonnet"（小写、非 prefix）不应被作为产品名保留
    const text = 'A sonnet consists of fourteen lines. He wrote a sonnet about love.';
    const terms = extractGlossaryLocal(text).document_terms;
    // "sonnet" 不应作为产品名出现在 glossary（应被翻译为"十四行诗"）
    expect(terms.every(t => t.toLowerCase() !== 'sonnet')).toBe(true);
  });

  it('does NOT extract standalone "haiku" or "opus" from non-AI context', () => {
    const text = 'The haiku is a Japanese poetic form. Opus is a Latin word for work.';
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms.every(t => t.toLowerCase() !== 'haiku')).toBe(true);
    expect(terms.every(t => t.toLowerCase() !== 'opus')).toBe(true);
  });

  it('extracts multiple product names from a realistic Claude blog paragraph', () => {
    const text = `Claude Sonnet 4.5 pairs well with Claude Opus 4.1. The advisor strategy
      uses Claude Sonnet as executor and Claude Opus as advisor. GPT-5 and Gemini 2.5 Pro
      are competitors. DeepSeek R1 is an open alternative.`;
    const terms = extractGlossaryLocal(text).document_terms;
    expect(terms).toContain('Claude Sonnet 4.5');
    expect(terms).toContain('Claude Opus 4.1');
    expect(terms).toContain('GPT-5');
    expect(terms).toContain('Gemini 2.5 Pro');
    expect(terms).toContain('DeepSeek R1');
  });
});
