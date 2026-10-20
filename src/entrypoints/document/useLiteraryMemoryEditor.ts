import { computed, ref, type Ref } from 'vue';
import { getConfig, type Config } from '@/entrypoints/utils/config';
import type { ParsedDocument } from '@/entrypoints/utils/document/types';
import {
  sanitizeLiteraryMemory,
  type LiteraryBookMemory,
  type LiteraryEntity,
  type LiteraryRelationship,
} from '@/entrypoints/utils/document/literary';
import { workspaceApi } from './documentWorkspaceClient';

export interface LiteraryMemoryEditorDeps {
  literaryMemory: Ref<LiteraryBookMemory>;
  doc: Ref<ParsedDocument | null>;
  state: Ref<any>;
  readerConfig: Ref<Config | null>;
  workspaceProject: Ref<any>;
  ensureWorkspace: () => Promise<any | null>;
  persistenceMessage: Ref<string>;
  persistSession: () => Promise<void>;
  /** 延迟读取：Context Graph 状态由 `useContextGraph` 持有，避免两个 composable 循环依赖。 */
  getContextGraphOverview: () => { narrativeStyle: string; styleRegister: string; styleRhythm: string; styleDialogue: string; styleDiction: string; styleRules: string[]; styleAvoid: string[] };
}

/**
 * 人物、实体、关系与声音画像的编辑状态。
 *
 * 所有写操作都经 `persistLiteraryMemoryToWorkspace()` 串行落库：
 * 显式记忆编辑先写扩展会话，再同步到本机 workspace 的 memory revision。
 */
export function useLiteraryMemoryEditor(deps: LiteraryMemoryEditorDeps) {
    const { literaryMemory, doc, state, readerConfig, workspaceProject, persistenceMessage } = deps;

  interface ManagedPersonItem {
    key: string;
    entity?: LiteraryEntity;
    entityIndex?: number;
    profile?: LiteraryBookMemory['characterVoices'][number];
  }
  const entitySearch = ref('');
  const entityFilter = ref<'all' | 'pending' | 'confirmed'>('all');
  const personSearch = ref('');
  const nonPersonEntities = computed(() => literaryMemory.value.entities.filter((entity) => entity.kind !== 'person'));
  const pendingEntityCount = computed(() => nonPersonEntities.value.filter((entity) => entity.reviewStatus !== 'confirmed').length);
  const confirmedEntityCount = computed(() => nonPersonEntities.value.filter((entity) => entity.reviewStatus === 'confirmed').length);
  function normalizeManagedPersonName(value: unknown): string {
    return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s._'’-]+/g, ' ').trim();
  }
  const managedPeople = computed<ManagedPersonItem[]>(() => {
    const items: ManagedPersonItem[] = [];
    const profiles = literaryMemory.value.characterVoices;
    const usedProfileIds = new Set<string>();
    for (const [entityIndex, entity] of literaryMemory.value.entities.entries()) {
      if (entity.kind !== 'person') continue;
      const entityNames = new Set([entity.source, ...(entity.aliases || [])].map(normalizeManagedPersonName).filter(Boolean));
      const profile = profiles.find((candidate) => !usedProfileIds.has(candidate.characterId) &&
        [candidate.canonicalSourceName, ...candidate.aliases].map(normalizeManagedPersonName).some((name) => entityNames.has(name)));
      if (profile) usedProfileIds.add(profile.characterId);
      items.push({
        key: profile?.characterId || 'person-entity-' + entityIndex,
        entity, entityIndex, profile,
      });
    }
    for (const profile of profiles) {
      if (usedProfileIds.has(profile.characterId)) continue;
      const profileNames = new Set([profile.canonicalSourceName, ...profile.aliases].map(normalizeManagedPersonName).filter(Boolean));
      const entityMatch = literaryMemory.value.entities
        .map((entity, entityIndex) => ({ entity, entityIndex }))
        .find(({ entity }) => entity.kind === 'person' &&
          [entity.source, ...(entity.aliases || [])].map(normalizeManagedPersonName).some((name) => profileNames.has(name)));
      if (entityMatch) {
        const priorItem = items.find((item) => item.entity === entityMatch.entity);
        if (priorItem) priorItem.profile = profile;
        else items.push({ key: profile.characterId, entity: entityMatch.entity, entityIndex: entityMatch.entityIndex, profile });
      } else {
        items.push({ key: profile.characterId, profile });
      }
    }
    return items;
  });
  const filteredManagedPeople = computed(() => {
    const query = personSearch.value.trim().toLocaleLowerCase();
    if (!query) return managedPeople.value;
    return managedPeople.value.filter((item) => {
      const profile = item.profile;
      const searchable = [
        item.entity?.source, item.entity?.target, ...(item.entity?.aliases || []),
        profile?.canonicalSourceName, profile?.targetName, ...(profile?.aliases || []),
        profile?.role, ...(profile?.traits || []),
        profile?.voiceCore.register, ...(profile?.voiceCore.syntaxRhythm || []),
        ...(profile?.voiceCore.lexicalPreferences || []), ...(profile?.voiceCore.discourseHabits || []),
        ...(profile?.evidence || []).map((evidence) => evidence.sourceQuote),
      ].filter((value): value is string => typeof value === 'string');
      return searchable.some((value) => value.toLocaleLowerCase().includes(query));
    });
  });
  const pendingRelationshipCount = computed(() => literaryMemory.value.relationships.filter((relation) => relation.reviewStatus !== 'confirmed').length);
  const pendingCharacterVoiceCount = computed(() => literaryMemory.value.characterVoices.filter((profile) => profile.status === 'candidate').length +
    literaryMemory.value.relationshipVoiceRules.filter((rule) => rule.status === 'candidate').length);
  const confirmedCharacterVoiceCount = computed(() => literaryMemory.value.characterVoices.filter((profile) => profile.status === 'confirmed').length +
    literaryMemory.value.relationshipVoiceRules.filter((rule) => rule.status === 'confirmed').length);
  const confirmableRelationshipCount = computed(() => literaryMemory.value.relationships.filter((relation) =>
    relation.reviewStatus !== 'confirmed' && !!relation.subject.trim() && !!relation.predicate.trim() && !!relation.object.trim(),
  ).length);
  const hasStyleGuideContent = computed(() => {
    const style = literaryMemory.value.styleGuide || {};
    return [style.narrativeVoice, style.register, style.rhythm, style.dialogue, style.diction]
      .some((value) => typeof value === 'string' && value.trim()) ||
      (style.rules || []).some((value) => value.trim()) ||
      (style.avoid || []).some((value) => value.trim());
  });
  const filteredLiteraryEntities = computed(() => {
    const query = entitySearch.value.toLocaleLowerCase();
    return literaryMemory.value.entities
      .map((entity, index) => ({ entity, index }))
      .filter(({ entity }) => entity.kind !== 'person')
      .filter(({ entity }) => {
        if (entityFilter.value === 'pending' && entity.reviewStatus === 'confirmed') return false;
        if (entityFilter.value === 'confirmed' && entity.reviewStatus !== 'confirmed') return false;
        if (!query) return true;
        return [entity.source, entity.target, ...(entity.aliases ?? [])]
          .some((value) => value.toLocaleLowerCase().includes(query));
      });
  });

  const entitySourceBeforeEdit = new WeakMap<LiteraryEntity, string>();
  function rememberEntitySource(entity: LiteraryEntity) {
    entitySourceBeforeEdit.set(entity, entity.source);
  }

  function syncEntityMappingToVoiceProfiles(entity: LiteraryEntity, previousSource = '') {
    const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s._'’-]+/g, ' ').trim();
    const canonicalSource = entity.source.trim();
    const aliases = Array.from(new Set([
      ...(entity.aliases || []),
      ...(previousSource && normalize(previousSource) !== normalize(canonicalSource) ? [previousSource] : []),
    ].map((name) => name.trim()).filter((name) => name && normalize(name) !== normalize(canonicalSource)))).slice(0, 12);
    if (previousSource && normalize(previousSource) !== normalize(canonicalSource)) entity.aliases = aliases;
    const names = new Set([canonicalSource, ...aliases].map(normalize).filter(Boolean));
    if (!names.size) return;
    for (const profile of literaryMemory.value.characterVoices) {
      const profileNames = [profile.canonicalSourceName, ...profile.aliases].map(normalize).filter(Boolean);
      if (!profileNames.some((name) => names.has(name))) continue;
      const oldCanonical = profile.canonicalSourceName;
      profile.canonicalSourceName = canonicalSource || oldCanonical;
      profile.aliases = Array.from(new Set([
        ...aliases,
        ...(oldCanonical && normalize(oldCanonical) !== normalize(canonicalSource || oldCanonical) ? [oldCanonical] : []),
      ].filter((name) => normalize(name) !== normalize(canonicalSource || oldCanonical)))).slice(0, 12);
      entity.aliases = profile.aliases;
      if (entity.target.trim()) profile.targetName = entity.target.trim();
      else delete profile.targetName;
    }
  }

  function managedPersonSource(item: ManagedPersonItem): string {
    return item.entity?.source || item.profile?.canonicalSourceName || '';
  }
  function managedPersonTarget(item: ManagedPersonItem): string {
    return item.entity?.target || item.profile?.targetName || '';
  }
  function managedPersonAliases(item: ManagedPersonItem): string[] {
    const canonical = normalizeManagedPersonName(managedPersonSource(item));
    return Array.from(new Set([
      ...(item.entity?.aliases || []),
      ...(item.profile?.aliases || []),
    ].map((value) => value.trim()).filter((value) => value && normalizeManagedPersonName(value) !== canonical)));
  }
  function findManagedPersonEntity(item: ManagedPersonItem): LiteraryEntity | undefined {
    if (item.entity && literaryMemory.value.entities.includes(item.entity)) return item.entity;
    const names = new Set([
      managedPersonSource(item),
      ...(item.profile?.aliases || []),
      ...(item.entity?.aliases || []),
    ].map(normalizeManagedPersonName).filter(Boolean));
    if (!names.size) return undefined;
    return literaryMemory.value.entities.find((entity) => entity.kind === 'person' &&
      [entity.source, ...(entity.aliases || [])].map(normalizeManagedPersonName).some((name) => names.has(name)));
  }
  function ensureManagedPersonEntity(item: ManagedPersonItem): LiteraryEntity | undefined {
    const existing = findManagedPersonEntity(item);
    if (existing) return existing;
    const profile = item.profile;
    const source = managedPersonSource(item).trim();
    const target = managedPersonTarget(item).trim();
    if (!source || !target) return undefined;
    const evidenceRefs = (profile?.evidence || []).slice(0, 8).map((evidence) => ({
      segmentId: evidence.segmentId, sourceQuote: evidence.sourceQuote,
    }));
    const entity: LiteraryEntity = {
      source, target, kind: 'person',
      aliases: managedPersonAliases(item).slice(0, 12),
      ...(evidenceRefs[0]?.sourceQuote ? { evidence: evidenceRefs[0].sourceQuote } : {}),
      ...(evidenceRefs.length ? { evidenceRefs } : {}),
      reviewStatus: evidenceRefs.length ? 'confirmed' : 'suggested',
    };
    literaryMemory.value.entities.push(entity);
    return entity;
  }
  function updateManagedPerson(item: ManagedPersonItem, field: 'source' | 'target' | 'aliases', event: Event) {
    const input = event.target as HTMLInputElement | null;
    const value = (input?.value || '').trim();
    const oldSource = managedPersonSource(item);
    let entity = findManagedPersonEntity(item);
    const profile = item.profile;
    if (field === 'source') {
      if (entity) entity.source = value;
      else if (profile) {
        if (oldSource && normalizeManagedPersonName(oldSource) !== normalizeManagedPersonName(value)) {
          profile.aliases = Array.from(new Set([...profile.aliases, oldSource])).filter((name) =>
            normalizeManagedPersonName(name) !== normalizeManagedPersonName(value)).slice(0, 12);
        }
        profile.canonicalSourceName = value;
      }
    } else if (field === 'target') {
      if (entity) entity.target = value;
      if (profile) {
        if (value) profile.targetName = value;
        else delete profile.targetName;
      }
    } else {
      const aliases = Array.from(new Set((input?.value || '').split(',').map((name) => name.trim()).filter(Boolean)))
        .filter((name) => normalizeManagedPersonName(name) !== normalizeManagedPersonName(oldSource)).slice(0, 12);
      if (entity) entity.aliases = aliases;
      if (profile) profile.aliases = aliases;
    }

    entity = entity || ensureManagedPersonEntity(item);
    if (entity) {
      entity.reviewStatus = entity.source.trim() && entity.target.trim() ? 'confirmed' : 'suggested';
      if (entity.reviewStatus === 'confirmed') entity.confirmationSource = 'user-confirmed';
      else delete entity.confirmationSource;
      syncEntityMappingToVoiceProfiles(entity, field === 'source' ? oldSource : '');
    }
    // A hand-added person mapping requires both names before the sanitizer can persist it.
    // Keep a partial row locally while the user fills the second field; profiles with source evidence
    // can still be persisted independently before a translation name has been assigned.
    if (entity && (!entity.source.trim() || !entity.target.trim()) && !profile) {
      persistenceMessage.value = '请补全规范原文名和统一译名后保存人物映射。';
      return;
    }
    void persistLiteraryMemoryToWorkspace().catch((error) => {
      persistenceMessage.value = '保存人物资料失败：' + (error instanceof Error ? error.message : String(error));
    });
  }
  function addManagedPerson() {
    literaryMemory.value.entities.push({
      source: '', target: '', kind: 'person', aliases: [], reviewStatus: 'suggested',
    });
    persistenceMessage.value = '已添加人物：填写规范原文名和统一译名后会保存；角色与声音信息可随后合并进来。';
  }
  function removeManagedPerson(item: ManagedPersonItem) {
    const names = new Set([
      managedPersonSource(item), ...(item.entity?.aliases || []), ...(item.profile?.aliases || []),
    ].map(normalizeManagedPersonName).filter(Boolean));
    const entity = findManagedPersonEntity(item);
    if (entity) {
      const entityIndex = literaryMemory.value.entities.indexOf(entity);
      if (entityIndex >= 0) literaryMemory.value.entities.splice(entityIndex, 1);
    }
    const characterId = item.profile?.characterId;
    if (characterId) {
      literaryMemory.value.characterVoices = literaryMemory.value.characterVoices.filter((profile) => profile.characterId !== characterId)
        .map((profile) => ({ ...profile, contrastRules: profile.contrastRules.filter((rule) => rule.otherCharacterId !== characterId) }));
      literaryMemory.value.relationshipVoiceRules = literaryMemory.value.relationshipVoiceRules.filter((rule) =>
        rule.speakerId !== characterId && rule.addresseeId !== characterId);
      literaryMemory.value.voiceAnchors = literaryMemory.value.voiceAnchors.filter((anchor) => anchor.speakerId !== characterId);
    }
    literaryMemory.value.relationships = literaryMemory.value.relationships.filter((relation) =>
      !names.has(normalizeManagedPersonName(relation.subject)) &&
      !names.has(normalizeManagedPersonName(relation.object)));
    void persistLiteraryMemoryToWorkspace().catch((error) => {
      persistenceMessage.value = '移除人物资料失败：' + (error instanceof Error ? error.message : String(error));
    });
  }

  function markEntitySuggested(entity: LiteraryEntity) {
    const previousSource = entitySourceBeforeEdit.get(entity) || '';
    entitySourceBeforeEdit.delete(entity);
    syncEntityMappingToVoiceProfiles(entity, previousSource);
    // 完整映射由用户直接编辑，或由有原文证据的预处理生成时，立即生效；不要求逐条点击确认.
    entity.reviewStatus = entity.source.trim() && entity.target.trim() ? 'confirmed' : 'suggested';
    if (entity.reviewStatus === 'confirmed') entity.confirmationSource = 'user-confirmed';
    else delete entity.confirmationSource;
    void persistLiteraryMemoryToWorkspace().catch((error) => {
      persistenceMessage.value = '保存实体译名失败：' + (error instanceof Error ? error.message : String(error));
    });
  }
  function entityKindLabel(kind: LiteraryEntity['kind']) {
    const labels: Record<LiteraryEntity['kind'], string> = {
      person: '人物', place: '地点', object: '物品', organization: '组织', concept: '概念', other: '其他实体',
    };
    return labels[kind] || '其他实体';
  }

  function setEntityAliases(entity: LiteraryEntity, event: Event) {
    const value = (event.target as HTMLInputElement | null)?.value ?? '';
    entity.aliases = Array.from(new Set(value.split(',').map((alias) => alias.trim()).filter(Boolean))).slice(0, 8);
    syncEntityMappingToVoiceProfiles(entity);
    entity.reviewStatus = entity.source.trim() && entity.target.trim() ? 'confirmed' : 'suggested';
    if (entity.reviewStatus === 'confirmed') entity.confirmationSource = 'user-confirmed';
    else delete entity.confirmationSource;
    void persistLiteraryMemoryToWorkspace().catch((error) => {
      persistenceMessage.value = '保存实体别名失败：' + (error instanceof Error ? error.message : String(error));
    });
  }
  function addEntity() {
    entitySearch.value = '';
    entityFilter.value = 'all';
    literaryMemory.value.entities.push({ source: '', target: '', kind: 'other', aliases: [], reviewStatus: 'suggested' });
    persistenceMessage.value = '已添加空白映射：填写原文名称和统一译名后会自动生效';
  }
  function removeEntity(index: number) {
    literaryMemory.value.entities.splice(index, 1);
    void persistLiteraryMemoryToWorkspace().catch((error) => {
      persistenceMessage.value = '移除实体映射失败：' + (error instanceof Error ? error.message : String(error));
    });
  }
  function markRelationshipSuggested(relation: LiteraryRelationship) {
    relation.reviewStatus = 'suggested';
    delete relation.confirmationSource;
    if (relation.subject.trim() && relation.predicate.trim() && relation.object.trim()) {
      void persistLiteraryMemoryToWorkspace().catch((error) => {
        persistenceMessage.value = '保存人物关系失败：' + (error instanceof Error ? error.message : String(error));
      });
    }
  }
  function confirmRelationship(relation: LiteraryRelationship) {
    if (!relation.subject.trim() || !relation.predicate.trim() || !relation.object.trim()) return;
    relation.reviewStatus = 'confirmed';
    relation.confirmationSource = 'user-confirmed';
    persistenceMessage.value = '已确认关系：' + relation.subject + ' — ' + relation.predicate + ' → ' + relation.object;
    void persistLiteraryMemoryToWorkspace().catch((error) => {
      persistenceMessage.value = '保存人物关系失败：' + (error instanceof Error ? error.message : String(error));
    });
  }
  function confirmAllRelationships() {
    let count = 0;
    for (const relation of literaryMemory.value.relationships) {
      if (relation.reviewStatus !== 'confirmed' && relation.subject.trim() && relation.predicate.trim() && relation.object.trim()) {
        relation.reviewStatus = 'confirmed';
        relation.confirmationSource = 'user-confirmed';
        count++;
      }
    }
    persistenceMessage.value = count > 0 ? '已确认剩余关系 ' + count + ' 项' : '没有待确认的关系';
    if (count > 0) void persistLiteraryMemoryToWorkspace().catch((error) => {
      persistenceMessage.value = '保存人物关系失败：' + (error instanceof Error ? error.message : String(error));
    });
  }
  function characterName(characterId: string): string {
    const profile = literaryMemory.value.characterVoices.find((item) => item.characterId === characterId);
    return profile?.targetName || profile?.canonicalSourceName || characterId;
  }

  /** 人物画像/人物对规则/锚点的状态变化是记忆数据，不是 Prompt 文本修改。 */
  async function persistVoiceMemoryChange(message: string) {
    persistenceMessage.value = message;
    await deps.persistSession();
    // 人物声音审核属于显式记忆编辑：直接保存文学记忆 revision，不借助 Prompt 保存的副作用。
    if (readerConfig.value?.documentUseLocalAgent && doc.value) {
      try {
        await persistLiteraryMemoryToWorkspace();
      } catch (error) {
        persistenceMessage.value += '；但同步到本机 workspace 失败：' + (error instanceof Error ? error.message : String(error));
      }
    }
  }

  function normalizeVoiceEvidence(value: string): string {
    return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  }

  async function setCharacterVoiceStatus(profile: LiteraryBookMemory['characterVoices'][number], status: 'candidate' | 'confirmed' | 'rejected') {
    if (status === 'confirmed') {
      const grounded = profile.evidence.some((evidence) => {
        const source = doc.value?.segments.find((segment) => segment.id === evidence.segmentId)?.text;
        return !!source && !!evidence.sourceQuote.trim() &&
          normalizeVoiceEvidence(source).includes(normalizeVoiceEvidence(evidence.sourceQuote));
      });
      if (!grounded) {
        persistenceMessage.value = '人物声音画像没有匹配到当前文档中的原文证据，不能确认。';
        return;
      }
    }
    profile.status = status;
    if (status === 'confirmed') profile.confirmationSource = 'user-confirmed';
    else delete profile.confirmationSource;
    profile.useForTranslation = status !== 'rejected';
    await persistVoiceMemoryChange(
      status === 'confirmed' ? '已确认人物声音：' + profile.canonicalSourceName + '。后续相关对白会参考这份画像。'
        : status === 'rejected' ? '已拒绝人物声音画像：' + profile.canonicalSourceName + '。'
          : '已将人物声音画像移回候选：' + profile.canonicalSourceName + '。',
    );
  }
  async function setCharacterVoiceUse(profile: LiteraryBookMemory['characterVoices'][number], enabled: boolean) {
    if (enabled && !profile.evidence.length) {
      persistenceMessage.value = '没有原文证据的角色画像不能启用。';
      return;
    }
    if (enabled && profile.status === 'rejected') profile.status = 'candidate';
    profile.useForTranslation = enabled;
    await persistVoiceMemoryChange(
      enabled ? '已启用人物画像用于翻译：' + profile.canonicalSourceName + '。候选画像只作为弱提示。'
        : '已停用人物画像：' + profile.canonicalSourceName + '。后续翻译不再注入此画像。',
    );
  }

  async function setRelationshipVoiceStatus(rule: LiteraryBookMemory['relationshipVoiceRules'][number], status: 'candidate' | 'confirmed' | 'rejected') {
    if (status === 'confirmed' && !rule.evidenceSegmentIds.length) {
      persistenceMessage.value = '没有原文证据片段，不能确认人物对的说话规则。';
      return;
    }
    rule.status = status;
    if (status === 'confirmed') rule.confirmationSource = 'user-confirmed';
    else delete rule.confirmationSource;
    await persistVoiceMemoryChange(
      status === 'confirmed' ? '已确认有方向的人物对话规则：' + characterName(rule.speakerId) + ' → ' + characterName(rule.addresseeId) + '。'
        : status === 'rejected' ? '已拒绝该人物对话规则。' : '已将该人物对话规则移回候选。',
    );
  }
  async function editVoiceAnchor(anchor: LiteraryBookMemory['voiceAnchors'][number]) {
    anchor.status = 'candidate';
    delete anchor.confirmationSource;
    anchor.approvedBy = 'manual-edit';
    await persistVoiceMemoryChange('声音锚点译文已修改，需要重新批准。');
  }

  async function setVoiceAnchorStatus(anchor: LiteraryBookMemory['voiceAnchors'][number], status: 'candidate' | 'approved' | 'rejected') {
    const sourceSegment = doc.value?.segments.find((segment) => segment.id === anchor.segmentId);
    if (status === 'approved' && (!anchor.attributionEvidence || (anchor.attributionConfidence ?? 0) < 0.7 ||
      !sourceSegment || !normalizeVoiceEvidence(sourceSegment.text).includes(normalizeVoiceEvidence(anchor.attributionEvidence)))) {
      persistenceMessage.value = '缺少与当前原文匹配的说话人归属证据（置信度至少 70%），不能批准声音锚点。';
      return;
    }
    if (status === 'approved' && (!sourceSegment ||
      !normalizeVoiceEvidence(sourceSegment.text).includes(normalizeVoiceEvidence(anchor.source)))) {
      persistenceMessage.value = '锚点原文片段与当前文档不一致，不能批准。';
      return;
    }
    if (status === 'approved') {
      const acceptedTranslation = state.value.translations.get(anchor.segmentId) || '';
      if (!acceptedTranslation.trim() || !normalizeVoiceEvidence(acceptedTranslation).includes(normalizeVoiceEvidence(anchor.target))) {
        persistenceMessage.value = '锚点译文必须能在该段当前已采纳译文中找到。请先修改锚点译文，再批准。';
        return;
      }
    }
    if (status === 'approved' && !literaryMemory.value.characterVoices.some((profile) => profile.characterId === anchor.speakerId && profile.status === 'confirmed')) {
      persistenceMessage.value = '请先确认该说话人的声音画像，再批准此声音锚点。';
      return;
    }
    anchor.status = status;
    if (status === 'approved') {
      anchor.confirmationSource = 'user-confirmed';
      anchor.approvedBy = 'user';
    } else {
      delete anchor.confirmationSource;
    }
    await persistVoiceMemoryChange(
      status === 'approved' ? '已批准声音锚点；后续相关场景可复用这组原文—译文示例。'
        : status === 'rejected' ? '已拒绝该声音锚点。' : '已将声音锚点移回候选。',
    );
  }

  function addRelationship() {
    literaryMemory.value.relationships.push({ subject: '', predicate: '', object: '', reviewStatus: 'suggested' });
  }
  function removeRelationship(index: number) {
    literaryMemory.value.relationships.splice(index, 1);
    void persistLiteraryMemoryToWorkspace().catch((error) => {
      persistenceMessage.value = '移除人物关系失败：' + (error instanceof Error ? error.message : String(error));
    });
  }

  let literaryMemorySaveQueue: Promise<void> = Promise.resolve();
  let literaryMemoryEditSequence = 0;

  /**
   * Only explicit memory-edit actions call this method. Writes are serialized so rapid edit/confirm
   * actions cannot arrive out of order and restore an older memory revision.
   */
  async function persistLiteraryMemoryToWorkspace(): Promise<void> {
    const snapshot = sanitizeLiteraryMemory(JSON.parse(JSON.stringify(literaryMemory.value)));
    const sequence = ++literaryMemoryEditSequence;
    const write = async () => {
      await deps.persistSession();
      const config = readerConfig.value || await getConfig();
      readerConfig.value = config;
      if (!config.documentUseLocalAgent) return;
      let project = workspaceProject.value;
      if (!project?.projectId) {
        await deps.ensureWorkspace();
        project = workspaceProject.value;
      }
      if (!project?.projectId) return;
      const result = await workspaceApi<{ current?: { memory?: unknown } }>(
        config.documentLocalAgentUrl || 'http://127.0.0.1:8789',
        config.documentLocalAgentToken || '',
        '/api/documents/projects/' + encodeURIComponent(project.projectId) + '/literary-memory',
        { method: 'POST', body: JSON.stringify({ memory: snapshot }) },
      );
      // A newer edit may already be queued; don't replace its visible draft with this response.
      if (sequence === literaryMemoryEditSequence) {
        literaryMemory.value = sanitizeLiteraryMemory(result.current?.memory ?? snapshot);
        await deps.persistSession();
      }
    };
    const pending = literaryMemorySaveQueue.catch(() => undefined).then(write);
    literaryMemorySaveQueue = pending;
    return pending;
  }

  function markStyleGuideCandidate() {
    literaryMemory.value.styleGuideStatus = 'candidate';
    delete literaryMemory.value.styleGuideConfirmationSource;
    void persistLiteraryMemoryToWorkspace().catch((error) => {
      persistenceMessage.value = '保存全书文风基准失败：' + (error instanceof Error ? error.message : String(error));
    });
  }

  function setStyleGuideLines(field: 'rules' | 'avoid', event: Event) {
    const raw = (event.target as HTMLTextAreaElement | null)?.value || '';
    literaryMemory.value.styleGuide[field] = Array.from(new Set(
      raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    )).slice(0, field === 'rules' ? 16 : 12);
    markStyleGuideCandidate();
  }

  function importContextGraphStyleGuide() {
    const style = literaryMemory.value.styleGuide || {};
    const overview = deps.getContextGraphOverview();
    const narrativeVoice = overview.narrativeStyle.trim();
    const register = overview.styleRegister.trim();
    const rhythm = overview.styleRhythm.trim();
    const dialogue = overview.styleDialogue.trim();
    const diction = overview.styleDiction.trim();
    const rules = overview.styleRules.slice(0, 16);
    const avoid = overview.styleAvoid.slice(0, 12);
    literaryMemory.value.styleGuide = {
      ...style,
      ...(narrativeVoice ? { narrativeVoice } : {}),
      ...(register ? { register } : {}),
      ...(rhythm ? { rhythm } : {}),
      ...(dialogue ? { dialogue } : {}),
      ...(diction ? { diction } : {}),
      ...(rules.length ? { rules } : {}),
      ...(avoid.length ? { avoid } : {}),
    };
    literaryMemory.value.styleGuideStatus = 'candidate';
    delete literaryMemory.value.styleGuideConfirmationSource;
    void persistLiteraryMemoryToWorkspace().catch((error) => {
      persistenceMessage.value = '保存预处理文风候选失败：' + (error instanceof Error ? error.message : String(error));
    });
  }

  async function setStyleGuideStatus(status: 'candidate' | 'confirmed') {
    if (status === 'confirmed' && !hasStyleGuideContent.value) return;
    literaryMemory.value.styleGuideStatus = status;
    if (status === 'confirmed') literaryMemory.value.styleGuideConfirmationSource = 'user-confirmed';
    else delete literaryMemory.value.styleGuideConfirmationSource;
    await persistLiteraryMemoryToWorkspace();
    persistenceMessage.value = status === 'confirmed'
      ? '全书文风基准已确认，后续文学翻译与 Reviewer 会注入这组风格规则。'
      : '全书文风基准已恢复为候选，不再注入后续翻译。';
  }

    /** 等待排队中的记忆写入完成（翻译前保证最新 Voice Bible 已落库）。 */
    function awaitLiteraryMemoryWrites(): Promise<void> {
      return literaryMemorySaveQueue.catch(() => undefined);
    }

  return {
    entitySearch,
    entityFilter,
    personSearch,
    nonPersonEntities,
    pendingEntityCount,
    confirmedEntityCount,
    managedPeople,
    filteredManagedPeople,
    pendingRelationshipCount,
    pendingCharacterVoiceCount,
    confirmedCharacterVoiceCount,
    confirmableRelationshipCount,
    hasStyleGuideContent,
    filteredLiteraryEntities,
    rememberEntitySource,
    managedPersonSource,
    managedPersonTarget,
    managedPersonAliases,
    updateManagedPerson,
    addManagedPerson,
    removeManagedPerson,
    markEntitySuggested,
    entityKindLabel,
    setEntityAliases,
    addEntity,
    removeEntity,
    markRelationshipSuggested,
    confirmRelationship,
    confirmAllRelationships,
    characterName,
    setCharacterVoiceStatus,
    setCharacterVoiceUse,
    setRelationshipVoiceStatus,
    editVoiceAnchor,
    setVoiceAnchorStatus,
    addRelationship,
    removeRelationship,
    persistLiteraryMemoryToWorkspace,
    awaitLiteraryMemoryWrites,
    markStyleGuideCandidate,
    setStyleGuideLines,
    importContextGraphStyleGuide,
    setStyleGuideStatus,
  };
}
