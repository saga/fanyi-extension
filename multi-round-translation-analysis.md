# Multi-round Conversation for Translation — Analysis

## Current Architecture

```
Page text → extractBlocks → buildChunks → [chunk1, chunk2, ...] → sequential API calls
                                                    ↓
                                            Each request is a fresh conversation
                                            system prompt + user prompt
                                            No cross-chunk context
```

Each chunk API request:
```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "system", "content": "Professional translator..." },
    { "role": "user", "content": "Translate and return JSON: [...blocks...]" }
  ]
}
```

## Problem

When translating a long article split into multiple chunks, each chunk is translated independently. This leads to:
- Inconsistent terminology (e.g., "LLM" translated as "大语言模型" in chunk 1 but "大型语言模型" in chunk 3)
- Lost context for pronouns and references across chunks
- No shared understanding of domain-specific terms

## Proposal A: Cumulative Context (Full History)

```json
// Chunk 2 request (with chunk 1 history)
messages: [
  { role: "system", content: "Translation rules..." },
  { role: "user", content: "Translate: [chunk1 blocks]" },
  { role: "assistant", content: "chunk1 translation result..." },
  { role: "user", content: "Translate: [chunk2 blocks]" }
]
```

### Pros
- Best terminology consistency
- Best cross-chunk context understanding

### Cons
- Token cost grows quadratically (10x for 10 chunks)
- Increased latency
- Cache invalidation (same chunk has different history at different positions)
- Error accumulation

### Token Cost Estimate (10 chunks, ~1800 tokens each)

| Chunk | Current input tokens | Multi-round input tokens | Growth |
|-------|---------------------|-------------------------|--------|
| 1     | ~1900               | ~1900                   | 1x     |
| 2     | ~1900               | ~5600                   | 2.9x   |
| 3     | ~1900               | ~9300                   | 4.9x   |
| 5     | ~1900               | ~16700                  | 8.8x   |
| 10    | ~1900               | ~35500                  | 18.7x  |

**Total: current ~19000, multi-round ~187000, ~10x increase!**

**Verdict: NOT recommended** — token cost is prohibitive.

---

## Proposal B: Two-Phase Glossary (Recommended)

```
Phase 1: Scan full text → Extract glossary (1 API call)
Phase 2: Each chunk translation includes glossary (independent calls, shared terminology context)
```

### Pros
- Good terminology consistency
- Controlled token growth (glossary is much smaller than full text)
- Cache-friendly (glossary is stable, each chunk can still be cached independently)
- No error accumulation

### Cons
- One extra API call (glossary extraction)
- Increased implementation complexity

### Token Cost Estimate

| Component      | Tokens  |
|----------------|---------|
| Glossary extraction (1x) | ~3000 |
| Per-chunk glossary overhead | ~200-500 |
| Total for 10 chunks | ~19000 + 3000 + 3000 = ~25000 |

**Only ~30% increase vs current, vs 10x for Proposal A.**

**Verdict: RECOMMENDED** — best cost/benefit ratio.

---

## Proposal C: Sliding Window Context

```
// Chunk N request (with only chunk N-1 history)
messages: [
  { role: "system", content: "Translation rules..." },
  { role: "user", content: "Translate: [chunk N-1 blocks]" },
  { role: "assistant", content: "chunk N-1 translation..." },
  { role: "user", content: "Translate: [chunk N blocks]" }
]
```

### Pros
- Moderate context improvement
- Controlled token growth (fixed 2-3x)
- Simple implementation

### Cons
- Cache still affected
- Limited window, distant terms still inconsistent

**Verdict: Optional** — decent middle ground but glossary approach is superior.

---

## Comparison

| Proposal          | Terminology | Token Cost | Complexity | Cache | Recommendation |
|-------------------|-------------|------------|------------|-------|----------------|
| Current           | ⭐⭐         | ⭐⭐⭐⭐⭐      | ⭐⭐⭐⭐⭐      | ⭐⭐⭐⭐⭐ | Baseline       |
| A: Cumulative     | ⭐⭐⭐⭐⭐      | ⭐          | ⭐⭐⭐        | ⭐     | ❌ No           |
| B: Glossary       | ⭐⭐⭐⭐       | ⭐⭐⭐⭐      | ⭐⭐         | ⭐⭐⭐⭐  | ✅ Yes          |
| C: Sliding Window | ⭐⭐⭐        | ⭐⭐⭐       | ⭐⭐⭐⭐      | ⭐⭐    | ⚠️ Optional    |

## Implementation Plan (Proposal B)

1. Add `extractGlossary()` method to DeepSeekTranslationService
2. In background.ts, add `extractGlossary` message handler
3. In content.ts, call glossary extraction before chunk translation
4. Pass glossary to each chunk's translation prompt
5. Cache glossary per page URL
