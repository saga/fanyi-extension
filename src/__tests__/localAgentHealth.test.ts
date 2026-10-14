import { afterEach, describe, expect, it, vi } from 'vitest';
import { isLocalAgentServiceAvailable } from '../entrypoints/utils/localAgentHealth';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isLocalAgentServiceAvailable', () => {
  it('returns true for the expected local-agent health response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, service: 'vocal-saga-local-agent', providers: ['workbuddy', 'opencode'] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(isLocalAgentServiceAvailable('http://127.0.0.1:8789/')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8789/health', expect.objectContaining({
      method: 'GET',
      cache: 'no-store',
    }));
  });

  it('does not treat another HTTP service as the local agent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, service: 'some-other-service' }),
    }));

    await expect(isLocalAgentServiceAvailable('http://127.0.0.1:8789')).resolves.toBe(false);
  });

  it('returns false when the service is not listening', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    await expect(isLocalAgentServiceAvailable('http://127.0.0.1:8789')).resolves.toBe(false);
  });

  it('returns false for an invalid URL without issuing a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(isLocalAgentServiceAvailable('not a URL')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
