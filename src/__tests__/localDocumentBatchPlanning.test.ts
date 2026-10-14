import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({
  default: { runtime: { sendMessage: vi.fn() } },
}));
import {
  planDocumentBatches,
  shouldUseRemoteDocumentTranslation,
} from '../entrypoints/document/useDocumentTranslation';
import type { DocumentSegment } from '../entrypoints/utils/document/types';

const segments = [
  { id: 's1', text: 'Hello', kind: 'paragraph', contextPath: 'Chapter 1', page: 1 },
  { id: 's2', text: 'World', kind: 'paragraph', contextPath: 'Chapter 1', page: 1 },
  { id: 's3', text: 'Next', kind: 'paragraph', contextPath: 'Chapter 2', page: 2 },
] as DocumentSegment[];

describe('local service document batch planning', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never selects the remote document API when the local provider is enabled', () => {
    expect(shouldUseRemoteDocumentTranslation({ useLocalAgent: true, useServerTranslation: true })).toBe(false);
    expect(shouldUseRemoteDocumentTranslation({ useLocalAgent: true, useServerTranslation: false })).toBe(false);
    expect(shouldUseRemoteDocumentTranslation({ useLocalAgent: false, useServerTranslation: true })).toBe(true);
  });

  it('uses service-planned IDs and preserves original segment objects/order', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ batches: [[{ id: 's1' }, { id: 's2' }], [{ id: 's3' }]] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await planDocumentBatches(segments, { maxChars: 3000, maxSegments: 24 }, {
      sourceLang: 'en', targetLang: 'zh', useLocalAgent: true,
      localAgentUrl: 'http://127.0.0.1:8789/', localAgentToken: 'local-token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8789/api/documents/batches');
    expect(result).toEqual([[segments[0], segments[1]], [segments[2]]]);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer local-token');
  });

  it('falls back only to deterministic CPU batching (not to any remote translation API) if planning is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('service stopped')));
    const result = await planDocumentBatches(segments, { maxChars: 5, maxSegments: 10 }, {
      sourceLang: 'en', targetLang: 'zh', useLocalAgent: true,
    });
    expect(result.map((batch) => batch.map((segment) => segment.id))).toEqual([['s1'], ['s2'], ['s3']]);
  });
});
