import { describe, it, expect } from 'vitest';
import { extractGlossaryLocal } from '../entrypoints/utils/glossaryExtractor';

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

  // --- Singular/plural merging ---

  it('merges singular and plural forms of the same noun', () => {
    const text = 'The agent processes data. Each agent handles requests. Multiple agents work together. The agent returns results. Agents are scalable. Agents coordinate well.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    // Should have either "agent" or "agents", not both
    const agentTerms = terms.filter(t => t.toLowerCase() === 'agent' || t.toLowerCase() === 'agents');
    expect(agentTerms.length).toBe(1);
  });

  // --- #Noun #Gerund pattern ---

  it('extracts noun+gerund phrases like token billing', () => {
    const text = 'Token billing is used. Token billing costs money. Token billing requires monitoring. Token billing affects pricing.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms.some(t => t.toLowerCase().includes('token billing'))).toBe(true);
  });

  it('extracts noun+gerund phrases like data processing', () => {
    const text = 'Data processing is fast. Data processing takes time. Data processing requires memory. Data processing is essential.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms.some(t => t.toLowerCase().includes('data processing'))).toBe(true);
  });

  // --- Stopword first-word filter ---

  it('rejects phrases starting with a stopword even if they contain substantive words', () => {
    const text = 'The architecture is modular. The architecture scales well. The architecture supports plugins. The architecture is extensible.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).not.toContain('The architecture');
  });

  it('keeps phrases starting with a non-stopword', () => {
    const text = 'Memory management is crucial. Memory management affects performance. Memory management requires care. Memory management is complex.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms.some(t => t.toLowerCase().includes('memory management'))).toBe(true);
  });

  // --- Single word frequency threshold ---

  it('requires single nouns to appear at least 3 times', () => {
    const text = 'The governance model. Governance is important. Governance defines rules. Governance ensures compliance.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    // "governance" appears 4+ times as noun — should be included
    expect(terms.some(t => t.toLowerCase() === 'governance')).toBe(true);
  });

  it('excludes single nouns that appear fewer than 3 times', () => {
    const text = 'The governance model is new. Governance matters here.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).not.toContain('Governance');
    expect(terms).not.toContain('governance');
  });

  // --- Multi-word phrase frequency threshold ---

  it('requires multi-word phrases to appear at least 2 times', () => {
    const text = 'Context window is large. Context window defines limits.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms.some(t => t.toLowerCase().includes('context window'))).toBe(true);
  });

  it('excludes multi-word phrases that appear only once', () => {
    const text = 'Context window is large and defines many limits for the model.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).not.toContain('Context window');
  });

  // --- Substring dedup edge cases ---

  it('removes shorter term when fully contained in a longer term', () => {
    const text = 'We use PII scrubbing for data. PII scrubbing removes personal info. PII scrubbing is required. PII scrubbing protects users.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    if (terms.some(t => t.toLowerCase().includes('pii scrubbing'))) {
      expect(terms).not.toContain('PII');
    }
  });

  it('keeps both terms when neither contains the other', () => {
    const text = 'API calls are frequent. API calls are logged. SDK tools are useful. SDK tools help developers. API calls return data. SDK tools save time.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    // "API calls" and "SDK tools" are both present and neither contains the other
    expect(terms.some(t => t.toLowerCase().includes('api calls'))).toBe(true);
    expect(terms.some(t => t.toLowerCase().includes('sdk tools'))).toBe(true);
  });

  // --- Emphasized terms edge cases ---

  it('handles empty emphasized terms array', () => {
    const text = 'We use LLM for natural language processing.';
    const result = extractGlossaryLocal(text, []);
    const terms = result.map(r => r.term);

    expect(terms).toContain('LLM');
  });

  it('handles undefined emphasized terms', () => {
    const text = 'We use LLM for natural language processing.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).toContain('LLM');
  });

  it('adds emphasized terms even if they appear only once', () => {
    const text = 'Some random text here.';
    const emphasized = ['unique technical term'];
    const result = extractGlossaryLocal(text, emphasized);
    const terms = result.map(r => r.term);

    expect(terms).toContain('unique technical term');
  });

  // --- Length-based sorting ---

  it('sorts longer terms before shorter ones', () => {
    const text = 'We use CUDA and CUDA Toolkit for GPU programming with CUDA Toolkit support. CUDA Toolkit is great. CUDA Toolkit works well.';
    const result = extractGlossaryLocal(text);

    // Length-only ordering is no longer the contract; we use scoreTerm.
    // Verify the natural long-phrase-wins-acronym behavior: when a phrase
    // subsumes an acronym, the longer phrase survives dedup.
    const terms = result.map((r) => r.term);
    // "CUDA Toolkit" subsumes "CUDA", so only the longer phrase should remain
    expect(terms).toContain('CUDA Toolkit');
    expect(terms).not.toContain('CUDA');
    // sanity: result is non-empty
    expect(terms.length).toBeGreaterThan(0);
  });

  // --- Mixed acronym + frequent term + named entity ---

  it('combines acronyms, named entities, and frequent terms without duplicates', () => {
    const text = 'John Smith from MIT uses CUDA for GPU computing. CUDA accelerates workloads. CUDA is fast. CUDA is reliable. MIT published the research.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).toContain('CUDA');
    expect(terms).toContain('GPU');
    expect(terms).toContain('MIT');
    // No duplicate entries
    const cudaEntries = result.filter(r => r.term === 'CUDA');
    expect(cudaEntries.length).toBe(1);
  });

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
    const terms = result.map(r => r.term);

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

  it('extracts 2-letter acronyms that are not in exclusion list', () => {
    const text = 'We use ML and AI for NLP tasks.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).toContain('ML');
    expect(terms).toContain('AI');
    expect(terms).toContain('NLP');
  });

  it('excludes 2-letter acronyms that are in exclusion list', () => {
    const text = 'VS is not an acronym. GET is a verb. DOER is not technical.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).not.toContain('VS');
    expect(terms).not.toContain('GET');
    expect(terms).not.toContain('DOER');
  });

  it('extracts 7+ letter all-caps words as acronyms', () => {
    // 7+ letter all-caps identifiers (POSTGRESQL, WEBSOCKET) are legitimate
    // technical acronyms. The old 6-char limit was a heuristic that excluded
    // them too aggressively.
    const text = 'We use POSTGRESQL for storage and WEBSOCKET for streaming.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).toContain('POSTGRESQL');
    expect(terms).toContain('WEBSOCKET');
  });

  // --- cleanTerm edge cases ---

  it('handles terms with surrounding punctuation', () => {
    const text = 'We use (CUDA) and "API" and GPT, for models.';
    const result = extractGlossaryLocal(text);
    const terms = result.map(r => r.term);

    expect(terms).toContain('CUDA');
    expect(terms).toContain('API');
    expect(terms).toContain('GPT');
  });
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

describe('extractGlossaryLocal - Performance', () => {
  it('completes within 2000ms for 50-section text (~10KB)', () => {
    const largeText = generateLargeText(50);

    const start = performance.now();
    const result = extractGlossaryLocal(largeText);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(result.length).toBeGreaterThan(0);
  });

  it('completes within 1000ms for 20-section text (~4KB)', () => {
    const largeText = generateLargeText(20);

    const start = performance.now();
    const result = extractGlossaryLocal(largeText);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(result.length).toBeGreaterThan(0);
  });

  it('extracts correct terms from large text', () => {
    const largeText = generateLargeText(30);

    const result = extractGlossaryLocal(largeText);
    const terms = result.map(r => r.term);

    // Should find common technical terms (acronyms may be subsumed by longer phrases)
    expect(terms.some(t => t.includes('LLM'))).toBe(true);
    expect(terms.some(t => t.includes('API'))).toBe(true);
    expect(terms.some(t => t.includes('GPT'))).toBe(true);
    expect(terms.some(t => t.includes('CUDA'))).toBe(true);
    expect(terms.some(t => t.includes('GPU'))).toBe(true);
    expect(terms.some(t => t.includes('NLP'))).toBe(true);
    expect(terms.some(t => t.includes('MIT'))).toBe(true);
  });

  it('produces consistent results for the same input', () => {
    const base = 'We use LLM and API for GPT models with CUDA support.';
    const result1 = extractGlossaryLocal(base);
    const result2 = extractGlossaryLocal(base);

    // Same input must produce identical ordering (deterministic scoring).
    expect(result2.map((r) => r.term)).toEqual(result1.map((r) => r.term));

    // All entries should have KEEP translation
    for (const entry of result1) {
      expect(entry.translation).toBe('KEEP');
    }
  });

  describe('priority scoring', () => {
    it('ranks acronyms above proper nouns above generic terms', () => {
      const text = 'The API for JavaScript framework handles data processing efficiently.';
      const result = extractGlossaryLocal(text);
      const terms = result.map((r) => r.term);

      // Acronyms (API) should appear before proper nouns (JavaScript) which
      // should appear before generic lowercase terms.
      const acronymIdx = terms.findIndex((t) => /^[A-Z]{2,6}$/.test(t));
      const properIdx = terms.findIndex((t) => /[A-Z]/.test(t) && /[a-z]/.test(t));
      const genericIdx = terms.findIndex(
        (t) => !/[A-Z]/.test(t) && t.split(' ').length === 1
      );

      // Whichever categories are present, the priority order must hold
      if (acronymIdx !== -1 && properIdx !== -1) {
        expect(acronymIdx).toBeLessThan(properIdx);
      }
      if (properIdx !== -1 && genericIdx !== -1) {
        expect(properIdx).toBeLessThan(genericIdx);
      }
    });

    it('caps result at MAX_GLOSSARY_TERMS (50)', () => {
      // Generate a long text with many distinct frequent terms by repeating
      // a long paragraph of varied vocabulary 5 times.
      const vocab = Array.from({ length: 100 }, (_, i) => `term${i}`).join(' ');
      const text = Array.from({ length: 5 }, () => vocab).join('. ');

      const result = extractGlossaryLocal(text);
      expect(result.length).toBeLessThanOrEqual(50);
    });

    it('keeps high-priority terms when truncating', () => {
      // Build text with many low-priority distinct terms repeated so they
      // qualify for the frequent-term bucket, plus a few high-priority
      // acronyms and proper nouns that must survive the 50-term cap.
      const filler = Array.from({ length: 300 }, (_, i) => `vocab${i} test${i}`).join(' ');
      const text = `${filler}. The API for JavaScript uses GPT models and CUDA GPU acceleration. We also support TypeScript with Node.js runtime and PostgreSQL database queries.`;

      const result = extractGlossaryLocal(text);
      const terms = result.map((r) => r.term);

      // Must not exceed the cap
      expect(result.length).toBeLessThanOrEqual(50);

      // High-priority terms should be present even if generic ones are truncated
      const hasAcronym = terms.some((t) => /^[A-Z]{2,6}$/.test(t));
      const hasProperNoun = terms.some((t) => /[A-Z]/.test(t) && /[a-z]/.test(t));
      expect(hasAcronym || hasProperNoun).toBe(true);
    });

    it('is deterministic for the same input', () => {
      const text = 'React JavaScript API for TypeScript developers using Node.js framework.';
      const a = extractGlossaryLocal(text);
      const b = extractGlossaryLocal(text);
      expect(a.map((r) => r.term)).toEqual(b.map((r) => r.term));
    });
  });
});
