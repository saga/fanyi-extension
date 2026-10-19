import {
  autoConfirmLiteraryMemory,
  mergeCharacterVoiceConfidence,
  type LiteraryBookMemory,
  type LiteraryEntity,
  type LiteraryRelationship,
} from '@/entrypoints/utils/document/literary';

/**
 * 把服务端 Context Graph 的人物/实体/关系/文风候选合并进当前书籍记忆。
 *
 * 纯函数：不读取响应式状态，也不发起请求；已人工确认的映射与声音画像优先保留。
 */
export function mergeContextGraphEntitySuggestions(graph: any, memory: LiteraryBookMemory): LiteraryBookMemory {
  const next = JSON.parse(JSON.stringify(memory)) as LiteraryBookMemory;
  let existing = [...(next.entities || [])];
  let existingVoices = [...(next.characterVoices || [])];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const candidates: LiteraryEntity[] = nodes.flatMap((node: any) => {
    if (node?.status === 'rejected') return [];
    const target = typeof node?.attributes?.suggestedTranslation === 'string'
      ? node.attributes.suggestedTranslation.trim() : '';
    const source = typeof node?.name === 'string' ? node.name.trim() : '';
    if (!source || !target || !Array.isArray(node.evidence) || !node.evidence.length) return [];
    const rawKind = node.kind === 'character' ? 'person' : node.attributes?.entityKind;
    const kind = ['person', 'place', 'object', 'organization', 'concept', 'other'].includes(rawKind) ? rawKind : 'other';
    const aliases = Array.isArray(node.attributes?.aliases)
      ? Array.from(new Set(node.attributes.aliases.filter((item: unknown): item is string => typeof item === 'string' && item.trim())))
      : [];
    const evidenceRefs = node.evidence.slice(0, 8).flatMap((item: any) =>
      typeof item?.segmentId === 'string' && item.segmentId.trim() &&
      typeof item?.quote === 'string' && item.quote.trim()
        ? [{ segmentId: item.segmentId, sourceQuote: item.quote.slice(0, 240) }]
        : []);
    return [{
      source, target, kind, aliases,
      evidence: typeof node.evidence[0]?.quote === 'string' ? node.evidence[0].quote : '',
      ...(evidenceRefs.length ? { evidenceRefs } : {}),
      // Context Graph evidence has already been checked by the Local Agent service against source segments.
      // The entity mapping can be active without pretending the user explicitly confirmed it.
      reviewStatus: node.status === 'confirmed' || evidenceRefs.length > 0 ? 'confirmed' : 'suggested',
      ...(evidenceRefs.length ? { confirmationSource: 'evidence-verified' as const } : {}),
    }];
  });
  const normalizeName = (value: unknown) => String(value || '').normalize('NFKC')
    .toLocaleLowerCase().replace(/[\s._'’-]+/g, ' ').trim();
  const rejectedGraphNames = new Set(nodes
    .filter((node: any) => node?.status === 'rejected')
    .flatMap((node: any) => [
      node?.name,
      ...(Array.isArray(node?.attributes?.aliases) ? node.attributes.aliases : []),
    ])
    .map(normalizeName)
    .filter(Boolean));
  if (rejectedGraphNames.size) {
    existing = existing.filter((entity) => entity.reviewStatus === 'confirmed' ||
      ![entity.source, ...(entity.aliases || [])].some((name) => rejectedGraphNames.has(normalizeName(name))));
    existingVoices = existingVoices.filter((profile) =>
      profile.status === 'confirmed' || profile.status === 'rejected' ||
      !profile.characterId.startsWith('context-graph-') ||
      ![profile.canonicalSourceName, ...profile.aliases].some((name) => rejectedGraphNames.has(normalizeName(name))));
  }
  const entityNames = (entity: LiteraryEntity) =>
    new Set([entity.source, ...(entity.aliases || [])].map(normalizeName).filter(Boolean));
  const overlaps = (a: LiteraryEntity, b: LiteraryEntity) => {
    const namesA = entityNames(a);
    return Array.from(entityNames(b)).some((name) => namesA.has(name));
  };

  for (const candidate of candidates) {
    // A new alias can bridge multiple old rows; collapse the connected group instead of
    // leaving conflicting translations for the same character in the visible glossary.
    const matchingIndices: number[] = [];
    existing.forEach((prior, index) => {
      if (overlaps(prior, candidate)) matchingIndices.push(index);
    });
    if (!matchingIndices.length) {
      existing.push(candidate);
      continue;
    }
    const canonicalIndex = matchingIndices[0]!;
    const matching = matchingIndices.map((index) => existing[index]!);
    const confirmed = matching.find((item) => item.reviewStatus === 'confirmed');
    const priorCanonical = matching[0];
    const canonicalSource = confirmed?.source || priorCanonical?.source || candidate.source;
    // A source-evidenced full-book Context Graph mapping is the best canonical default. Preserve
    // a target only when it was already active; otherwise replace an older unconfirmed draft
    // (which may itself have been an inconsistent LLM translation) with the preprocessing target.
    const target = confirmed?.target || candidate.target || priorCanonical?.target;
    const kind = confirmed?.kind || priorCanonical?.kind || candidate.kind;
    const aliases = Array.from(new Set([
      ...matching.flatMap((item) => [item.source, ...(item.aliases || [])]),
      candidate.source, ...(candidate.aliases || []),
    ].filter((name) => normalizeName(name) && normalizeName(name) !== normalizeName(canonicalSource))));
    const evidence = confirmed?.evidence || matching.find((item) => item.evidence)?.evidence || candidate.evidence || '';
    // Keep the source locations used by the server's temporal memory filter. A legacy
    // confirmed mapping with no citations remains protected and does not acquire unreviewed
    // later evidence merely because a Context Graph node shares its name.
    const canMergeEvidenceRefs = !confirmed ||
      matching.some((item) => Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0);
    const evidenceRefs = canMergeEvidenceRefs
      ? [...matching.flatMap((item) => item.evidenceRefs || []), ...(candidate.evidenceRefs || [])]
          .filter((item, index, all) => all.findIndex((other) =>
            other.segmentId === item.segmentId && normalizeName(other.sourceQuote) === normalizeName(item.sourceQuote)) === index)
          .slice(0, 8)
      : [];
    existing[canonicalIndex] = {
      source: canonicalSource, target, kind, aliases: aliases.slice(0, 12),
      ...(evidence ? { evidence } : {}),
      ...(evidenceRefs.length ? { evidenceRefs } : {}),
      reviewStatus: confirmed || candidate.reviewStatus === 'confirmed' ? 'confirmed' : 'suggested',
      ...((confirmed || candidate.reviewStatus === 'confirmed') ? {
        confirmationSource: confirmed?.confirmationSource === 'user-confirmed' ? 'user-confirmed' as const
          : evidenceRefs.length ? 'evidence-verified' as const
            : confirmed?.confirmationSource || 'legacy-unknown' as const,
      } : {}),
    };
    for (const index of matchingIndices.slice(1).sort((a, b) => b - a)) existing.splice(index, 1);
  }

  // Context Graph voice observations are grounded in sampled source quotes. Keep them as candidates,
  // but default them to enabled weak hints so they do not require one-by-one confirmation.
  const voiceCandidates = nodes.flatMap((node: any) => {
    if (node?.kind !== 'character' || node?.status === 'rejected') return [];
    const canonicalSourceName = typeof node?.name === 'string' ? node.name.trim() : '';
    const targetName = typeof node?.attributes?.suggestedTranslation === 'string'
      ? node.attributes.suggestedTranslation.trim() : '';
    const voices = Array.isArray(node?.attributes?.voice)
      ? Array.from(new Set(node.attributes.voice.filter((item: unknown): item is string =>
          typeof item === 'string' && item.trim()))).slice(0, 8)
      : [];
    const aliases = Array.isArray(node?.attributes?.aliases)
      ? Array.from(new Set(node.attributes.aliases.filter((item: unknown): item is string =>
          typeof item === 'string' && item.trim()))).slice(0, 12)
      : [];
    const role = typeof node?.attributes?.role === 'string' ? node.attributes.role.trim().slice(0, 360) : '';
    const traits = Array.isArray(node?.attributes?.traits)
      ? Array.from(new Set(node.attributes.traits.filter((item: unknown): item is string =>
          typeof item === 'string' && item.trim()))).slice(0, 10).map((item) => item.slice(0, 160))
      : [];
    const evidenceRows = Array.isArray(node?.evidence) ? node.evidence.filter((item: any) =>
      typeof item?.segmentId === 'string' && typeof item?.quote === 'string' && item.quote.trim()).slice(0, 6) : [];
    if (!canonicalSourceName || (!voices.length && !role && !traits.length) || !evidenceRows.length) return [];
    const observation = voices.length
      ? voices.join('；').slice(0, 240)
      : '角色定位/人物特征候选；请核对下列原文证据后再确认。';
    const evidenceDimension = voices.length ? 'register' as const : 'role_traits' as const;
    return [{
      characterId: 'context-graph-' + String(node.id || normalizeName(canonicalSourceName)).slice(0, 80),
      canonicalSourceName,
      ...(targetName ? { targetName } : {}),
      aliases,
      ...(role ? { role } : {}),
      ...(traits.length ? { traits } : {}),
      status: 'candidate' as const,
      useForTranslation: true,
      confidence: null,
      voiceCore: voices.length ? { register: observation } : {},
      contrastRules: [],
      evidence: evidenceRows.map((item: any) => ({
        segmentId: item.segmentId,
        sourceQuote: item.quote.slice(0, 240),
        observation,
        dimension: evidenceDimension,
        confidence: null,
      })),
      openQuestions: ['全书预分析生成的候选角色/声音信息；请结合完整对白与原文证据核对后再确认。'],
    }];
  });
  for (const candidate of voiceCandidates) {
    const candidateNames = new Set([candidate.canonicalSourceName, ...candidate.aliases].map(normalizeName).filter(Boolean));
    const matchingIndices: number[] = [];
    existingVoices.forEach((prior, index) => {
      if ([prior.canonicalSourceName, ...prior.aliases].map(normalizeName).some((name) => candidateNames.has(name))) {
        matchingIndices.push(index);
      }
    });
    if (!matchingIndices.length) {
      existingVoices.push(candidate);
      continue;
    }
    const canonicalIndex = matchingIndices[0]!;
    const matching = matchingIndices.map((index) => existingVoices[index]!);
    const protectedProfile = matching.find((profile) => profile.status === 'confirmed' || profile.status === 'rejected');
    const canonicalSourceName = protectedProfile?.canonicalSourceName || candidate.canonicalSourceName;
    const aliases = Array.from(new Set([
      ...matching.flatMap((profile) => [profile.canonicalSourceName, ...profile.aliases]),
      candidate.canonicalSourceName, ...candidate.aliases,
    ].filter((name) => normalizeName(name) && normalizeName(name) !== normalizeName(canonicalSourceName)))).slice(0, 12);
    const confidencePrior = matching.find((profile) =>
      profile.confidenceSource === 'model_self_report' && profile.confidence !== null) || matching[0]!;
    const confidenceFields = mergeCharacterVoiceConfidence(confidencePrior, candidate);
    const activationPrior = matching.find((profile) => profile.useForTranslation === false) || matching[0]!;
    const useForTranslation = protectedProfile?.useForTranslation ?? activationPrior.useForTranslation ?? candidate.useForTranslation;
    const evidence = [
      ...(protectedProfile?.evidence || matching[0]!.evidence),
      ...candidate.evidence,
    ].filter((item, index, all) =>
      all.findIndex((other) => other.segmentId === item.segmentId && other.sourceQuote === item.sourceQuote) === index,
    ).slice(0, 12);
    existingVoices[canonicalIndex] = {
      ...(protectedProfile || candidate),
      characterId: protectedProfile?.characterId || candidate.characterId,
      canonicalSourceName,
      ...(protectedProfile?.targetName ? { targetName: protectedProfile.targetName } : candidate.targetName ? { targetName: candidate.targetName } : {}),
      aliases,
      status: protectedProfile?.status || 'candidate',
      useForTranslation: protectedProfile?.status === 'rejected' ? false : useForTranslation,
      ...confidenceFields,
      voiceCore: protectedProfile ? protectedProfile.voiceCore : candidate.voiceCore,
      ...(!protectedProfile && candidate.role ? { role: candidate.role } : protectedProfile?.role ? { role: protectedProfile.role } : {}),
      ...(!protectedProfile && candidate.traits?.length ? { traits: candidate.traits } : protectedProfile?.traits?.length ? { traits: protectedProfile.traits } : {}),
      contrastRules: protectedProfile?.contrastRules || [],
      evidence,
      openQuestions: Array.from(new Set([...matching.flatMap((profile) => profile.openQuestions), ...candidate.openQuestions])).slice(0, 8),
    };
    for (const index of matchingIndices.slice(1).sort((a, b) => b - a)) existingVoices.splice(index, 1);
  }
  // Use one canonical person identity across the entity glossary and the voice profile.
  // Name, aliases and translation edits in the glossary are therefore reflected in the profile.
  const sameName = (a: unknown, b: unknown) => normalizeName(a) === normalizeName(b);
  for (const profile of existingVoices) {
    const profileNames = new Set([profile.canonicalSourceName, ...(profile.aliases || [])].map(normalizeName).filter(Boolean));
    let entity = existing.find((item) =>
      item.kind === 'person' &&
      [item.source, ...(item.aliases || [])].map(normalizeName).some((name) => profileNames.has(name)),
    );
    if (!entity && profile.targetName && profile.evidence.length) {
      const evidenceRefs = profile.evidence.slice(0, 8).map((item) => ({
        segmentId: item.segmentId, sourceQuote: item.sourceQuote,
      }));
      entity = {
        source: profile.canonicalSourceName, target: profile.targetName, kind: 'person',
        aliases: profile.aliases.slice(0, 12),
        evidence: profile.evidence[0]?.sourceQuote || '',
        ...(evidenceRefs.length ? { evidenceRefs } : {}),
        reviewStatus: evidenceRefs.length ? 'confirmed' : 'suggested',
      };
      existing.push(entity);
    }
    if (!entity) continue;
    const canonicalSource = entity.source.trim() || profile.canonicalSourceName;
    const aliases = Array.from(new Set([
      ...(entity.aliases || []),
      ...(profile.aliases || []),
      ...(profile.canonicalSourceName && !sameName(profile.canonicalSourceName, canonicalSource) ? [profile.canonicalSourceName] : []),
    ].map((name) => String(name || '').trim()).filter((name) => name && !sameName(name, canonicalSource)))).slice(0, 12);
    entity.aliases = aliases;
    profile.canonicalSourceName = canonicalSource;
    profile.aliases = aliases;
    if (entity.target.trim()) profile.targetName = entity.target.trim();
    else if (!profile.targetName) delete profile.targetName;
    else entity.target = profile.targetName;
  }

  // Context Graph already persisted evidenced relationship edges, but the reader memory bridge
  // previously copied only nodes. Bridge those edges into the visible relationship list as well.
  const graphNodesById = new Map(nodes.map((node: any) => [String(node?.id || ''), node] as [string, any]));
  const canonicalPersonName = (node: any): string => {
    const name = typeof node?.name === 'string' ? node.name.trim() : '';
    const nodeNames = new Set([name, ...(Array.isArray(node?.attributes?.aliases) ? node.attributes.aliases : [])]
      .map(normalizeName).filter(Boolean));
    const entity = existing.find((item) => item.kind === 'person' &&
      [item.source, ...(item.aliases || [])].map(normalizeName).some((candidateName) => nodeNames.has(candidateName)));
    return entity?.source || name;
  };
  const relationshipCandidates: LiteraryRelationship[] = (Array.isArray(graph?.edges) ? graph.edges : []).flatMap((edge: any) => {
    if (!edge || edge.status === 'rejected') return [];
    const fromNode = graphNodesById.get(String(edge.sourceNodeId || '')) as any;
    const toNode = graphNodesById.get(String(edge.targetNodeId || '')) as any;
    const subject = canonicalPersonName(fromNode);
    const object = canonicalPersonName(toNode);
    const attributes = edge.attributes && typeof edge.attributes === 'object' ? edge.attributes : {};
    const predicate = typeof attributes.description === 'string' && attributes.description.trim()
      ? attributes.description.trim()
      : typeof edge.kind === 'string' ? edge.kind.trim() : '';
    const evidenceRows = Array.isArray(edge.evidence) ? edge.evidence.filter((item: any) =>
      typeof item?.segmentId === 'string' && item.segmentId.trim() &&
      typeof item?.quote === 'string' && item.quote.trim()).slice(0, 8) : [];
    if (!subject || !predicate || !object || !evidenceRows.length) return [];
    return [{
      subject, predicate, object,
      evidence: evidenceRows[0].quote.slice(0, 240),
      evidenceRefs: evidenceRows.map((item: any) => ({
        segmentId: item.segmentId, sourceQuote: item.quote.slice(0, 240),
      })),
      reviewStatus: 'suggested' as const,
    }];
  });
  const relationshipKey = (relation: LiteraryRelationship) =>
    [relation.subject, relation.predicate, relation.object].map(normalizeName).join('|');
  for (const candidate of relationshipCandidates) {
    const key = relationshipKey(candidate);
    const index = next.relationships.findIndex((relation) => relationshipKey(relation) === key);
    if (index < 0) {
      next.relationships.push(candidate);
      continue;
    }
    const prior = next.relationships[index]!;
    const evidenceRefs = [...(prior.evidenceRefs || []), ...(candidate.evidenceRefs || [])]
      .filter((item, i, all) => all.findIndex((other) =>
        other.segmentId === item.segmentId && normalizeName(other.sourceQuote) === normalizeName(item.sourceQuote)) === i)
      .slice(0, 8);
    next.relationships[index] = {
      ...prior,
      evidence: prior.evidence || candidate.evidence,
      ...(evidenceRefs.length ? { evidenceRefs } : {}),
      reviewStatus: prior.reviewStatus === 'confirmed' ? 'confirmed' : 'suggested',
    };
  }

  next.entities = existing.slice(0, 120);
  next.characterVoices = existingVoices.slice(0, 80);
  const currentStyle = next.styleGuide || {};
  const currentStyleHasContent = [currentStyle.narrativeVoice, currentStyle.register, currentStyle.rhythm, currentStyle.dialogue, currentStyle.diction]
    .some((value) => typeof value === 'string' && value.trim()) ||
    (currentStyle.rules || []).some((value) => value.trim()) ||
    (currentStyle.avoid || []).some((value) => value.trim());
  const suggestedNarrative = typeof graph?.overview?.narrativeStyle === 'string' ? graph.overview.narrativeStyle.trim() : '';
  const suggestedRules = Array.isArray(graph?.overview?.styleRules)
    ? Array.from(new Set(graph.overview.styleRules.filter((value: unknown): value is string => typeof value === 'string' && value.trim()))).slice(0, 16)
    : [];
  if (next.styleGuideStatus !== 'confirmed' && !currentStyleHasContent && (suggestedNarrative || suggestedRules.length)) {
    next.styleGuide = {
      ...currentStyle,
      ...(suggestedNarrative ? { narrativeVoice: suggestedNarrative } : {}),
      ...(suggestedRules.length ? { rules: suggestedRules } : {}),
    };
    next.styleGuideStatus = 'candidate';
  }
  return autoConfirmLiteraryMemory(next);
}
