/**
 * 文学电子书专用的跨章节记忆类型与纯函数。
 *
 * 只由 EPUB/PDF 文档翻译工作流使用；不接入普通网页翻译的默认 prompt。
 * 记忆对象会在每个章节结束后合并，给后续段落的术语、实体关系与文风校准使用。
 */
export type LiteraryEntityKind = 'person' | 'place' | 'object' | 'organization' | 'concept' | 'other';

export interface LiteraryEntity {
  source: string;
  target: string;
  kind: LiteraryEntityKind;
  aliases?: string[];
  description?: string;
  evidence?: string;
}
export interface LiteraryRelationship {
  subject: string;
  predicate: string;
  object: string;
  evidence?: string;
}
export interface LiteraryStyleGuide {
  narrativeVoice?: string;
  register?: string;
  rhythm?: string;
  dialogue?: string;
  diction?: string;
  avoid?: string[];
}
export interface LiteraryExample {
  source: string;
  target: string;
  chapter?: string;
}
export interface LiteraryBookMemory {
  version: 1;
  entities: LiteraryEntity[];
  relationships: LiteraryRelationship[];
  styleGuide: LiteraryStyleGuide;
  chapterSummaries: Array<{ chapter: string; summary: string }>;
  recentExamples: LiteraryExample[];
}

const MAX_ENTITIES = 120;
const MAX_RELATIONSHIPS = 160;
const MAX_SUMMARIES = 40;
const MAX_EXAMPLES = 8;

function safeText(value: unknown, max = 320): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
function entityKind(value: unknown): LiteraryEntityKind {
  return value === 'person' || value === 'place' || value === 'object' ||
    value === 'organization' || value === 'concept' || value === 'other'
    ? value
    : 'other';
}
export function createEmptyLiteraryMemory(): LiteraryBookMemory {
  return { version: 1, entities: [], relationships: [], styleGuide: {}, chapterSummaries: [], recentExamples: [] };
}
function dedupeEntities(entities: LiteraryEntity[]): LiteraryEntity[] {
  const seen = new Set<string>();
  return entities.filter((entity) => {
    const key = entity.source.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function dedupeRelationships(relationships: LiteraryRelationship[]): LiteraryRelationship[] {
  const seen = new Set<string>();
  return relationships.filter((rel) => {
    const key = [rel.subject, rel.predicate, rel.object].join('|').toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sanitizeLiteraryMemory(input: unknown): LiteraryBookMemory {
  const empty = createEmptyLiteraryMemory();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return empty;
  const raw = input as Record<string, unknown>;
  const entities: LiteraryEntity[] = [];
  if (Array.isArray(raw.entities)) {
    for (const item of raw.entities.slice(0, MAX_ENTITIES * 2)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entity = item as Record<string, unknown>;
      const source = safeText(entity.source, 120);
      const target = safeText(entity.target, 120);
      if (!source || !target) continue;
      const aliases = Array.isArray(entity.aliases)
        ? Array.from(new Set(entity.aliases.map((alias) => safeText(alias, 80)).filter(Boolean))).slice(0, 8)
        : [];
      entities.push({
        source, target, kind: entityKind(entity.kind),
        ...(aliases.length ? { aliases } : {}),
        ...(safeText(entity.description, 200) ? { description: safeText(entity.description, 200) } : {}),
        ...(safeText(entity.evidence, 160) ? { evidence: safeText(entity.evidence, 160) } : {}),
      });
    }
  }
  const relationships: LiteraryRelationship[] = [];
  if (Array.isArray(raw.relationships)) {
    for (const item of raw.relationships.slice(0, MAX_RELATIONSHIPS * 2)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rel = item as Record<string, unknown>;
      const subject = safeText(rel.subject, 120);
      const predicate = safeText(rel.predicate, 100);
      const object = safeText(rel.object, 120);
      if (!subject || !predicate || !object) continue;
      relationships.push({
        subject, predicate, object,
        ...(safeText(rel.evidence, 160) ? { evidence: safeText(rel.evidence, 160) } : {}),
      });
    }
  }
  const styleRaw = raw.styleGuide && typeof raw.styleGuide === 'object' && !Array.isArray(raw.styleGuide)
    ? raw.styleGuide as Record<string, unknown>
    : {};
  const styleGuide: LiteraryStyleGuide = {};
  for (const key of ['narrativeVoice', 'register', 'rhythm', 'dialogue', 'diction'] as const) {
    const value = safeText(styleRaw[key], 500);
    if (value) styleGuide[key] = value;
  }
  if (Array.isArray(styleRaw.avoid)) {
    const avoid = Array.from(new Set(styleRaw.avoid.map((value) => safeText(value, 100)).filter(Boolean))).slice(0, 12);
    if (avoid.length) styleGuide.avoid = avoid;
  }
  const chapterSummaries = Array.isArray(raw.chapterSummaries)
    ? raw.chapterSummaries.slice(-MAX_SUMMARIES).flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const value = item as Record<string, unknown>;
        const chapter = safeText(value.chapter, 120);
        const summary = safeText(value.summary, 420);
        return chapter && summary ? [{ chapter, summary }] : [];
      })
    : [];
  const recentExamples = Array.isArray(raw.recentExamples)
    ? raw.recentExamples.slice(-MAX_EXAMPLES).flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const value = item as Record<string, unknown>;
        const source = safeText(value.source, 240);
        const target = safeText(value.target, 320);
        const chapter = safeText(value.chapter, 120);
        return source && target ? [{ source, target, ...(chapter ? { chapter } : {}) }] : [];
      })
    : [];
  return {
    version: 1,
    entities: dedupeEntities(entities).slice(0, MAX_ENTITIES),
    relationships: dedupeRelationships(relationships).slice(0, MAX_RELATIONSHIPS),
    styleGuide, chapterSummaries, recentExamples,
  };
}

/** 已确认的规范译名优先，不允许下一章在没有证据时静默改名。 */
export function mergeLiteraryMemory(existingInput: unknown, incomingInput: unknown): LiteraryBookMemory {
  const existing = sanitizeLiteraryMemory(existingInput);
  const incoming = sanitizeLiteraryMemory(incomingInput);
  const entityMap = new Map(existing.entities.map((entity) => [entity.source.toLocaleLowerCase(), entity]));
  for (const entity of incoming.entities) {
    const key = entity.source.toLocaleLowerCase();
    const prior = entityMap.get(key);
    if (!prior) { entityMap.set(key, entity); continue; }
    entityMap.set(key, {
      ...prior,
      aliases: Array.from(new Set([...(prior.aliases ?? []), ...(entity.aliases ?? [])])).slice(0, 8),
      description: prior.description || entity.description,
      evidence: prior.evidence || entity.evidence,
    });
  }
  const styleGuide: LiteraryStyleGuide = { ...incoming.styleGuide, ...existing.styleGuide };
  const avoid = Array.from(new Set([...(existing.styleGuide.avoid ?? []), ...(incoming.styleGuide.avoid ?? [])])).slice(0, 12);
  if (avoid.length) styleGuide.avoid = avoid;
  const summaries = new Map<string, { chapter: string; summary: string }>();
  for (const item of [...existing.chapterSummaries, ...incoming.chapterSummaries]) {
    summaries.set(item.chapter.toLocaleLowerCase(), item);
  }
  return sanitizeLiteraryMemory({
    version: 1,
    entities: Array.from(entityMap.values()),
    relationships: [...existing.relationships, ...incoming.relationships],
    styleGuide,
    chapterSummaries: Array.from(summaries.values()).slice(-MAX_SUMMARIES),
    recentExamples: [...existing.recentExamples, ...incoming.recentExamples].slice(-MAX_EXAMPLES),
  });
}
export function addLiteraryExamples(memoryInput: unknown, examples: LiteraryExample[]): LiteraryBookMemory {
  const memory = sanitizeLiteraryMemory(memoryInput);
  const appended = examples.flatMap((item) => {
    const source = safeText(item.source, 240);
    const target = safeText(item.target, 320);
    const chapter = safeText(item.chapter, 120);
    return source && target ? [{ source, target, ...(chapter ? { chapter } : {}) }] : [];
  });
  return sanitizeLiteraryMemory({ ...memory, recentExamples: [...memory.recentExamples, ...appended].slice(-MAX_EXAMPLES) });
}

/** 将当前片段真正相关的实体映射与声线压成只读 JSON 数据，放入 user payload。 */
export function buildLiteraryContextForText(memoryInput: unknown, sourceText: string): string {
  const memory = sanitizeLiteraryMemory(memoryInput);
  const source = sourceText.toLocaleLowerCase();
  const entities = memory.entities.filter((entity) =>
    [entity.source, ...(entity.aliases ?? [])].some((name) => name && source.includes(name.toLocaleLowerCase())),
  ).slice(0, 10);
  const names = new Set(entities.map((entity) => entity.source.toLocaleLowerCase()));
  const relationships = memory.relationships.filter((relation) =>
    names.has(relation.subject.toLocaleLowerCase()) || names.has(relation.object.toLocaleLowerCase()),
  ).slice(0, 8);
  return JSON.stringify({
    entities: entities.map(({ source, target, kind, aliases }) => ({ source, target, kind, aliases })),
    relationships,
    styleGuide: memory.styleGuide,
    recentExamples: memory.recentExamples.slice(-2),
  }).slice(0, 1_200);
}

/** 可信、静态的文学翻译指令；动态书籍记忆由 contextPath 作为 user 数据传入。 */
export function buildLiteraryTranslationContextPrompt(chapterTitle = ''): string {
  return [
    '任务模式：书籍/文学作品的章节翻译，不要套用网页翻译的简短、信息压缩式表达。',
    '忠实保留原意、叙述视角、人物动机、事实细节和关系，在此基础上使用自然、有文学质感的目标语言。',
    '各片段的 contextPath 可能含有只读书籍记忆 JSON；用它维持人名、地名、关键物品名、别名、实体关系和整体声线的一致性。不得把 metadata/contextPath 混入译文。',
    '关系记忆只用于消歧，不要把角色关系说明写进正文。不要擅自解释悬念、含混、反讽和信息差。',
    '保持叙述声音、时代感、语域、句子节奏、对话口吻和用词习惯；不同人物不能被润色成同一种声音。',
    '去掉翻译腔和 AI 味：避免机械对应原文语序、模板化转折、重复总结、无意义强调、解释性补句和过度工整的排比。不要为了显得文学而添加原文没有的比喻或情绪。',
    '尊重段落边界与输入 ID，不合并、不删段。',
    '当前章节：' + chapterTitle.replace(/[\u0000-\u001f\u007f<>]/g, ' ').slice(0, 120),
  ].join('\n');
}
