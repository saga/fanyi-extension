import { describe, expect, it } from 'vitest';
import { autoConfirmLiteraryMemory, mergeLiteraryMemory, sanitizeLiteraryMemory } from '../entrypoints/utils/document/literary';

describe('literary memory source evidence', () => {
  it('preserves source-positioned evidence references for entities and relationships', () => {
    const memory = sanitizeLiteraryMemory({
      version: 2,
      entities: [{
        source: 'The King',
        target: '国王',
        kind: 'person',
        aliases: ['King'],
        evidence: 'The King looked at Max.',
        evidenceRefs: [
          { segmentId: 'segment-10', sourceQuote: 'The King looked at Max.' },
          { segmentId: '', sourceQuote: 'invalid reference' },
        ],
        reviewStatus: 'suggested',
      }],
      relationships: [{
        subject: 'The King',
        predicate: 'orders',
        object: 'Max',
        evidence: 'The King ordered Max to wait.',
        evidenceRefs: [{ segmentId: 'segment-18', sourceQuote: 'The King ordered Max to wait.' }],
        reviewStatus: 'suggested',
      }],
    });

    expect(memory.entities[0]?.evidenceRefs).toEqual([
      { segmentId: 'segment-10', sourceQuote: 'The King looked at Max.' },
    ]);
    expect(memory.relationships[0]?.evidenceRefs).toEqual([
      { segmentId: 'segment-18', sourceQuote: 'The King ordered Max to wait.' },
    ]);
  });

  it('keeps the first canonical target and merges evidence refs for matching suggested entities', () => {
    const existing = sanitizeLiteraryMemory({
      entities: [{
        source: 'The King', target: '国王', kind: 'person', aliases: ['King'],
        evidenceRefs: [{ segmentId: 'segment-10', sourceQuote: 'The King looked at Max.' }],
        reviewStatus: 'suggested',
      }],
    });
    const merged = mergeLiteraryMemory(existing, {
      entities: [{
        source: 'The King', target: '大王', kind: 'person', aliases: ['His Majesty'],
        evidenceRefs: [{ segmentId: 'segment-40', sourceQuote: 'The King addressed the men.' }],
        reviewStatus: 'suggested',
      }],
    });

    expect(merged.entities).toHaveLength(1);
    expect(merged.entities[0]?.target).toBe('国王');
    expect(merged.entities[0]?.aliases).toContain('His Majesty');
    expect(merged.entities[0]?.evidenceRefs).toEqual([
      { segmentId: 'segment-10', sourceQuote: 'The King looked at Max.' },
      { segmentId: 'segment-40', sourceQuote: 'The King addressed the men.' },
    ]);
  });
});


describe('automatic canonical entity activation', () => {
  it('automatically activates evidence-backed name mappings and leaves unsupported entries pending', () => {
    const memory = autoConfirmLiteraryMemory({
      entities: [
        {
          source: 'the King',
          target: '国王',
          kind: 'person',
          aliases: ['King'],
          evidence: 'But Timsen was much too clever to allow the King to see through him.',
          reviewStatus: 'suggested',
        },
        {
          source: 'Unknown title',
          target: '神秘称号',
          kind: 'other',
          aliases: [],
          evidence: '',
          reviewStatus: 'suggested',
        },
      ],
    });

    expect(memory.entities.find((entity) => entity.source === 'the King')?.reviewStatus).toBe('confirmed');
    expect(memory.entities.find((entity) => entity.source === 'Unknown title')?.reviewStatus).toBe('suggested');
  });
});
