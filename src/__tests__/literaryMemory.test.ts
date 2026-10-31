import { describe, expect, it } from 'vitest';
import { autoConfirmLiteraryMemory, mergeLiteraryMemory, sanitizeLiteraryMemory } from '../entrypoints/utils/document/literary';

describe('literary style guide dimensions', () => {
  it('preserves all full-book style dimensions and line-based rules', () => {
    const memory = sanitizeLiteraryMemory({
      styleGuide: {
        narrativeVoice: '第三人称全知叙事。',
        register: '正式、克制。',
        rhythm: '长短句交替，动作段落节奏较快。',
        dialogue: '对白简洁，称谓随关系变化。',
        diction: '保留日语敬称和航海词汇。',
        rules: ['-san 按场合译为先生/女士', 'Sire 统一译为大人'],
        avoid: ['避免现代网络流行语', '避免无依据增加心理描写'],
      },
      styleGuideStatus: 'candidate',
    });

    expect(memory.styleGuide).toEqual({
      narrativeVoice: '第三人称全知叙事。',
      register: '正式、克制。',
      rhythm: '长短句交替，动作段落节奏较快。',
      dialogue: '对白简洁，称谓随关系变化。',
      diction: '保留日语敬称和航海词汇。',
      rules: ['-san 按场合译为先生/女士', 'Sire 统一译为大人'],
      avoid: ['避免现代网络流行语', '避免无依据增加心理描写'],
    });
    expect(memory.styleGuideStatus).toBe('candidate');
  });
});

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


describe('literary style provenance and long fields', () => {
  it('preserves long style dimensions and machine/user provenance without truncation', () => {
    const longDialogue = '对白节奏'.repeat(180);
    const longDiction = '词汇选择'.repeat(180);
    const memory = sanitizeLiteraryMemory({
      styleGuide: { dialogue: longDialogue, diction: longDiction },
      styleGuideStatus: 'candidate',
      styleGuideOrigin: 'context-graph',
      styleGuideAnalysisVersion: 'context-graph-v9-canonical-entity-quality',
      styleGuideSourceRevisionId: 'source-revision-1',
      styleGuideAutoDisabled: true,
    });

    expect(memory.styleGuide.dialogue).toBe(longDialogue);
    expect(memory.styleGuide.diction).toBe(longDiction);
    expect(memory.styleGuideOrigin).toBe('context-graph');
    expect(memory.styleGuideAnalysisVersion).toBe('context-graph-v9-canonical-entity-quality');
    expect(memory.styleGuideSourceRevisionId).toBe('source-revision-1');
    expect(memory.styleGuideAutoDisabled).toBe(true);
    expect(memory.styleGuideConfirmationSource).toBeUndefined();
  });

  it('keeps a user-edited style distinct from a user-confirmed style', () => {
    const memory = sanitizeLiteraryMemory({
      styleGuide: { narrativeVoice: '冷静克制。' },
      styleGuideStatus: 'candidate',
      styleGuideOrigin: 'user-edited',
    });
    expect(memory.styleGuideOrigin).toBe('user-edited');
    expect(memory.styleGuideStatus).toBe('confirmed');
    expect(memory.styleGuideConfirmationSource).toBe('user-modified');
  });
});

describe('automatic canonical entity activation', () => {
  it('records source evidence without treating it as target translation confirmation', () => {
    const memory = autoConfirmLiteraryMemory({
      entities: [
        {
          source: 'the King',
          target: '国王',
          kind: 'person',
          aliases: ['King'],
          evidence: 'But Timsen was much too clever to allow the King to see through him.',
          evidenceRefs: [{ segmentId: 's1', sourceQuote: 'But Timsen was much too clever to allow the King to see through him.' }],
          reviewStatus: 'suggested',
        },
        {
          source: 'Unknown title',
          target: '神秘称号',
          kind: 'other',
          aliases: [],
          evidence: '',
          evidenceRefs: [{ segmentId: 's1', sourceQuote: 'a quote that is not in the source' }],
          reviewStatus: 'suggested',
        },
      ],
    }, [{ id: 's1', text: 'But Timsen was much too clever to allow the King to see through him.' }]);

    expect(memory.entities.find((entity) => entity.source === 'the King')?.reviewStatus).toBe('confirmed');
    expect(memory.entities.find((entity) => entity.source === 'the King')?.confirmationSource).toBe('evidence-verified');
    expect(memory.entities.find((entity) => entity.source === 'Unknown title')?.reviewStatus).toBe('confirmed');
    expect(memory.entities.find((entity) => entity.source === 'Unknown title')?.confirmationSource).toBe('model-default');
  });

  it('labels legacy confirmed records as source-unknown instead of inferring user approval', () => {
    const memory = sanitizeLiteraryMemory({
      entities: [{ source: 'Alice', target: '艾丽丝', kind: 'person', reviewStatus: 'confirmed' }],
      relationships: [{ subject: 'Alice', predicate: 'knows', object: 'Bob', reviewStatus: 'confirmed' }],
      characterVoices: [{
        characterId: 'char_alice', canonicalSourceName: 'Alice', targetName: '艾丽丝',
        status: 'confirmed', useForTranslation: true,
        voiceCore: { register: 'restrained' },
        evidence: [{ segmentId: 's1', sourceQuote: 'Alice answered.', dimension: 'register', observation: 'brief', confidence: null }],
      }],
      styleGuide: { register: 'restrained' }, styleGuideStatus: 'confirmed',
    });

    expect(memory.entities[0]?.confirmationSource).toBe('legacy-unknown');
    expect(memory.relationships[0]?.confirmationSource).toBe('legacy-unknown');
    expect(memory.characterVoices[0]?.confirmationSource).toBe('legacy-unknown');
    expect(memory.styleGuideConfirmationSource).toBe('legacy-unknown');
  });

  it('preserves explicit user confirmation over machine-generated candidates during memory merge', () => {
    const merged = mergeLiteraryMemory({
      entities: [{ source: 'Alice', target: '艾丽丝', kind: 'person', reviewStatus: 'confirmed', confirmationSource: 'legacy-unknown' }],
      characterVoices: [{
        characterId: 'char_alice', canonicalSourceName: 'Alice', targetName: '艾丽丝',
        status: 'candidate', useForTranslation: true,
        voiceCore: { register: 'restrained' },
        evidence: [{ segmentId: 's1', sourceQuote: 'Alice answered.', dimension: 'register', observation: 'brief', confidence: null }],
      }],
    }, {
      entities: [{ source: 'Alice', target: '艾丽丝', kind: 'person', reviewStatus: 'confirmed', confirmationSource: 'user-confirmed' }],
      characterVoices: [{
        characterId: 'char_alice', canonicalSourceName: 'Alice', targetName: '艾丽丝',
        status: 'confirmed', confirmationSource: 'user-confirmed', useForTranslation: true,
        voiceCore: { register: 'restrained' },
        evidence: [{ segmentId: 's1', sourceQuote: 'Alice answered.', dimension: 'register', observation: 'brief', confidence: null }],
      }],
    });

    expect(merged.entities[0]?.confirmationSource).toBe('user-confirmed');
    expect(merged.characterVoices[0]?.status).toBe('confirmed');
    expect(merged.characterVoices[0]?.confirmationSource).toBe('user-confirmed');
  });
});


describe('Chinese editorial profile versioning', () => {
  const profile = {
    version: 1,
    profileVersion: 3,
    status: 'confirmed',
    confirmationSource: 'user-confirmed',
    sourceRevisionId: 'source-revision-1',
    analysisVersion: 'chinese-editorial-profile-v1',
    sampleFingerprint: 'active-fingerprint',
    sampleCount: 24,
    chapterCount: 5,
    generatedAt: '2026-10-30T00:00:00.000Z',
    confirmedAt: '2026-10-30T01:00:00.000Z',
    profile: {
      narrativeVoice: '克制、疏离。',
      register: '现代书面语。',
      rhythm: '保留长句。',
      dialogue: '对白简洁。',
      diction: '准确节制。',
      rules: ['不擅自拆句。'],
      avoid: ['不增加心理描写。'],
    },
    evidenceRefs: [
      { segmentId: 's1', targetExcerpt: '她没有回答', observation: '对白克制', aspect: 'dialogue' },
    ],
    pendingUpdate: {
      version: 1,
      status: 'candidate',
      sourceRevisionId: 'source-revision-1',
      analysisVersion: 'chinese-editorial-profile-v1',
      sampleFingerprint: 'pending-fingerprint',
      basedOnFingerprint: 'active-fingerprint',
      sampleCount: 32,
      chapterCount: 7,
      generatedAt: '2026-10-31T00:00:00.000Z',
      profile: { narrativeVoice: '新版叙述声音。', rules: ['新版规则。'] },
      evidenceRefs: [
        { segmentId: 's2', targetExcerpt: '他仍然沉默', observation: '新版证据', aspect: 'narrativeVoice' },
      ],
    },
  };

  it('automatically promotes a legacy pending editorial update during extension sanitization', () => {
    const memory = sanitizeLiteraryMemory({ chineseEditorialProfile: profile });
    expect(memory.chineseEditorialProfile?.status).toBe('confirmed');
    expect(memory.chineseEditorialProfile?.profileVersion).toBe(4);
    expect(memory.chineseEditorialProfile?.sampleFingerprint).toBe('pending-fingerprint');
    expect(memory.chineseEditorialProfile?.profile.narrativeVoice).toBe('新版叙述声音。');
    expect(memory.chineseEditorialProfile?.pendingUpdate).toBeUndefined();
  });

  it('keeps explicit user edits while auto-adopting a newer machine profile version', () => {
    const existing = sanitizeLiteraryMemory({ chineseEditorialProfile: profile });
    const merged = mergeLiteraryMemory(existing, {
      chineseEditorialProfile: {
        ...profile,
        status: 'candidate',
        confirmationSource: undefined,
        sampleFingerprint: 'unreviewed-incoming-candidate',
        profile: { narrativeVoice: '不应覆盖已确认版本。' },
        pendingUpdate: undefined,
      },
    });
    expect(merged.chineseEditorialProfile?.sampleFingerprint).toBe('pending-fingerprint');
    expect(merged.chineseEditorialProfile?.profile.narrativeVoice).toBe('新版叙述声音。');
    expect(merged.chineseEditorialProfile?.pendingUpdate).toBeUndefined();
  });
});
