import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

const { workspaceApiMock, getConfigMock } = vi.hoisted(() => ({
  workspaceApiMock: vi.fn(),
  getConfigMock: vi.fn(),
}));

vi.mock('../entrypoints/document/documentWorkspaceClient', () => ({
  workspaceApi: workspaceApiMock,
}));
vi.mock('@/entrypoints/utils/config', () => ({
  getConfig: getConfigMock,
}));

import { useLiteraryMemoryEditor } from '../entrypoints/document/useLiteraryMemoryEditor';
import { createEmptyContextGraphOverview } from '../entrypoints/document/useContextGraph';
import { createEmptyLiteraryMemory } from '../entrypoints/utils/document/literary';

function setupEditor(graph: any) {
  const literaryMemory = ref(createEmptyLiteraryMemory());
  const readerConfig = ref<any>({
    documentUseLocalAgent: true,
    documentLocalAgentUrl: 'http://127.0.0.1:8789',
    documentLocalAgentToken: 'test-token',
  });
  const workspaceProject = ref<any>({ projectId: 'project-1' });
  const persistenceMessage = ref('');
  const calls: Array<{ path: string; options?: any }> = [];

  workspaceApiMock.mockImplementation(async (_base: string, _token: string, path: string, options?: any) => {
    calls.push({ path, options });
    if (path.endsWith('/context-graph')) return { contextGraph: graph };
    if (path.endsWith('/context-graph/review')) return { success: true };
    if (path.endsWith('/literary-memory')) {
      const body = JSON.parse(options?.body || '{}');
      return { current: { memory: body.memory } };
    }
    throw new Error('Unexpected workspace API path: ' + path);
  });

  const editor = useLiteraryMemoryEditor({
    literaryMemory,
    doc: ref<any>(null),
    state: ref<any>({ translations: new Map(), activeSegmentIds: new Set() }),
    readerConfig,
    workspaceProject,
    ensureWorkspace: async () => workspaceProject.value,
    persistenceMessage,
    persistSession: async () => {},
    contextGraphOverview: ref(createEmptyContextGraphOverview()),
  });
  return { editor, literaryMemory, persistenceMessage, calls };
}

describe('literary memory deletion persistence', () => {
  beforeEach(() => {
    workspaceApiMock.mockReset();
    getConfigMock.mockReset();
  });

  it('rejects a matching entity node and persists the LiteraryMemory projection', async () => {
    const { editor, literaryMemory, calls } = setupEditor({
      nodes: [{ id: 'node-john', name: 'John Doe', attributes: { aliases: ['Johnny'] } }],
      edges: [{ id: 'edge-jane-john', sourceNodeId: 'node-jane', targetNodeId: 'node-john' }],
    });
    literaryMemory.value.entities.push({
      source: 'John Doe', target: '约翰', kind: 'person', aliases: ['Johnny'], reviewStatus: 'confirmed',
    } as any);

    await editor.removeEntity(0);

    expect(literaryMemory.value.entities).toHaveLength(0);
    const review = calls.filter((call) => call.path.endsWith('/context-graph/review'));
    expect(review.map((call) => JSON.parse(call.options.body))).toEqual([{
      items: [
        { type: 'node', id: 'node-john', status: 'rejected' },
        { type: 'edge', id: 'edge-jane-john', status: 'rejected' },
      ],
    }]);
    expect(calls.some((call) => call.path.endsWith('/literary-memory'))).toBe(true);
  });

  it('deletes a managed person only after rejecting its node and connected edges', async () => {
    const { editor, literaryMemory, calls } = setupEditor({
      nodes: [{ id: 'alice', name: 'Alice', attributes: { aliases: ['Ally'] } }],
      edges: [{ id: 'alice-bob', sourceNodeId: 'alice', targetNodeId: 'bob' }],
    });
    literaryMemory.value.entities.push({
      source: 'Alice', target: '艾丽丝', kind: 'person', aliases: ['Ally'], reviewStatus: 'confirmed',
    } as any);
    literaryMemory.value.relationships.push({
      subject: 'Alice', predicate: 'knows', object: 'Bob', reviewStatus: 'confirmed',
    } as any);

    await editor.removeManagedPerson(editor.managedPeople.value[0]);

    expect(literaryMemory.value.entities).toHaveLength(0);
    expect(literaryMemory.value.relationships).toHaveLength(0);
    const review = calls.filter((call) => call.path.endsWith('/context-graph/review'));
    expect(review.map((call) => JSON.parse(call.options.body))).toEqual([{
      items: [
        { type: 'node', id: 'alice', status: 'rejected' },
        { type: 'edge', id: 'alice-bob', status: 'rejected' },
      ],
    }]);
    expect(calls.some((call) => call.path.endsWith('/literary-memory'))).toBe(true);
  });

  it('does not delete the local entity when persistent Context Graph rejection fails', async () => {
    const { editor, literaryMemory, persistenceMessage } = setupEditor({
      nodes: [{ id: 'node-john', name: 'John Doe', attributes: {} }],
      edges: [],
    });
    literaryMemory.value.entities.push({
      source: 'John Doe', target: '约翰', kind: 'other', aliases: [], reviewStatus: 'confirmed',
    } as any);
    workspaceApiMock.mockImplementation(async (_base: string, _token: string, path: string) => {
      if (path.endsWith('/context-graph')) return { contextGraph: { nodes: [{ id: 'node-john', name: 'John Doe' }], edges: [] } };
      if (path.endsWith('/context-graph/review')) throw new Error('409 run active');
      throw new Error('Unexpected request: ' + path);
    });

    await editor.removeEntity(0);

    expect(literaryMemory.value.entities).toHaveLength(1);
    expect(persistenceMessage.value).toContain('未执行删除');
  });

  it('rejects only the exact relationship edge when endpoints and predicate match', async () => {
    const { editor, literaryMemory, calls } = setupEditor({
      nodes: [
        { id: 'alice', name: 'Alice', attributes: {} },
        { id: 'bob', name: 'Bob', attributes: {} },
      ],
      edges: [
        { id: 'alice-knows-bob', sourceNodeId: 'alice', targetNodeId: 'bob', attributes: { predicate: 'knows' } },
        { id: 'alice-trusts-bob', sourceNodeId: 'alice', targetNodeId: 'bob', attributes: { predicate: 'trusts' } },
      ],
    });
    literaryMemory.value.relationships.push({
      subject: 'Alice', predicate: 'knows', object: 'Bob', reviewStatus: 'confirmed',
    } as any);

    await editor.removeRelationship(0);

    expect(literaryMemory.value.relationships).toHaveLength(0);
    const review = calls.filter((call) => call.path.endsWith('/context-graph/review'));
    expect(review.map((call) => JSON.parse(call.options.body))).toEqual([{
      items: [{ type: 'edge', id: 'alice-knows-bob', status: 'rejected' }],
    }]);
  });

  it('never rejects a relationship by predicate alone when an endpoint is unknown', async () => {
    const { editor, literaryMemory, calls } = setupEditor({
      nodes: [{ id: 'alice', name: 'Alice', attributes: {} }],
      edges: [{ id: 'alice-knows-bob', sourceNodeId: 'alice', targetNodeId: 'bob', attributes: { predicate: 'knows' } }],
    });
    literaryMemory.value.relationships.push({
      subject: 'Alice', predicate: 'knows', object: 'Unknown Person', reviewStatus: 'confirmed',
    } as any);

    await editor.removeRelationship(0);

    expect(literaryMemory.value.relationships).toHaveLength(0);
    expect(calls.filter((call) => call.path.endsWith('/context-graph/review'))).toHaveLength(0);
  });
});
