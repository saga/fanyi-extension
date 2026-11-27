import { describe, expect, it, vi } from 'vitest';
import { createNetworkCaptureController } from '../entrypoints/utils/networkCapture';

function event() {
  let listener: ((...args: any[]) => unknown) | undefined;
  return {
    addListener: vi.fn((next: (...args: any[]) => unknown) => { listener = next; }),
    removeListener: vi.fn(),
    fire(...args: any[]) { return listener?.(...args); },
  };
}

describe('NetworkCaptureController', () => {
  it('captures Firefox webRequest metadata and bounded text bodies while redacting secrets', async () => {
    const onBeforeRequest = event();
    const onBeforeSendHeaders = event();
    const onHeadersReceived = event();
    const onCompleted = event();
    const onErrorOccurred = event();
    const filter = {
      ondata: undefined as ((event: { data: ArrayBuffer }) => void) | undefined,
      onstop: undefined as (() => void) | undefined,
      onerror: undefined as (() => void) | undefined,
      write: vi.fn(),
      close: vi.fn(),
      disconnect: vi.fn(),
    };
    const webRequest = {
      onBeforeRequest, onBeforeSendHeaders, onHeadersReceived, onCompleted, onErrorOccurred,
      filterResponseData: vi.fn(() => filter),
    };
    const controller = createNetworkCaptureController({
      webRequest,
      runtime: { getBrowserInfo: vi.fn() },
    });

    const started = await controller.start(23, true);
    expect(started.mode).toBe('firefox-webRequest');
    expect(onBeforeRequest.addListener).toHaveBeenCalledWith(
      expect.any(Function), { urls: ['<all_urls>'], tabId: 23 }, ['blocking', 'requestBody'],
    );

    onBeforeRequest.fire({
      requestId: 'req-1', tabId: 23, url: 'https://example.test/api?access_token=abc',
      method: 'POST', type: 'xmlhttprequest', timeStamp: 100,
      requestBody: { formData: { prompt: ['hello'], api_key: ['secret-value'] } },
    });
    onBeforeSendHeaders.fire({
      requestId: 'req-1',
      requestHeaders: [{ name: 'Authorization', value: 'Bearer private' }, { name: 'Accept', value: 'application/json' }],
    });
    onHeadersReceived.fire({
      requestId: 'req-1', statusCode: 200, statusLine: 'HTTP/2 200',
      responseHeaders: [{ name: 'content-type', value: 'application/json; charset=utf-8' }],
    });

    const data = new TextEncoder().encode('{"result":"ok","access_token":"body-secret"}');
    filter.ondata?.({ data: data.buffer });
    filter.onstop?.();
    onCompleted.fire({ requestId: 'req-1', statusCode: 200, timeStamp: 145 });

    const record = controller.snapshot().requests[0];
    expect(record).toBeDefined();
    if (!record) throw new Error('Expected captured Firefox request');
    expect(record.url).toContain('access_token=%5BREDACTED%5D');
    expect(record.requestHeaders?.Authorization).toBe('[REDACTED]');
    expect(record.requestHeaders?.Accept).toBe('application/json');
    expect(record.requestBody).toContain('[REDACTED]');
    expect(record.requestBody).not.toContain('secret-value');
    expect(record.responseBody).toContain('[REDACTED]');
    expect(record.responseBody).not.toContain('body-secret');
    expect(record.durationMs).toBe(45);
    expect(filter.write).toHaveBeenCalledTimes(1);
    expect(filter.close).toHaveBeenCalledTimes(1);

    await controller.stop();
    expect(onBeforeRequest.removeListener).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().active).toBe(false);
  });

  it('uses Chromium CDP Network events and detaches when stopped', async () => {
    const eventListeners = new Set<(...args: any[]) => void>();
    const detachListeners = new Set<(...args: any[]) => void>();
    const debuggerApi = {
      onEvent: {
        addListener: (listener: (...args: any[]) => void) => eventListeners.add(listener),
        removeListener: (listener: (...args: any[]) => void) => eventListeners.delete(listener),
      },
      onDetach: {
        addListener: (listener: (...args: any[]) => void) => detachListeners.add(listener),
        removeListener: (listener: (...args: any[]) => void) => detachListeners.delete(listener),
      },
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(async (_target: unknown, method: string) => {
        if (method === 'Network.getResponseBody') return { body: '{"ok":true}', base64Encoded: false };
        return {};
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const controller = createNetworkCaptureController({}, { debugger: debuggerApi });

    await controller.start(9, true);
    expect(debuggerApi.attach).toHaveBeenCalledWith({ tabId: 9 }, '1.3');

    const emit = (method: string, params: any) => {
      for (const listener of eventListeners) listener({ tabId: 9 }, method, params);
    };
    emit('Network.requestWillBeSent', {
      requestId: 'cdp-1', type: 'Fetch',
      request: { url: 'https://example.test/api?token=abc', method: 'GET', headers: { Accept: 'application/json' } },
    });
    emit('Network.responseReceived', {
      requestId: 'cdp-1', response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { 'set-cookie': 'secret' } },
    });
    emit('Network.loadingFinished', { requestId: 'cdp-1', encodedDataLength: 14 });
    await Promise.resolve();

    const record = controller.snapshot().requests[0];
    expect(record).toBeDefined();
    if (!record) throw new Error('Expected captured Chromium request');
    expect(record.url).toContain('token=%5BREDACTED%5D');
    expect(record.status).toBe(200);
    expect(record.responseHeaders?.['set-cookie']).toBe('[REDACTED]');
    expect(record.responseBody).toBe('{"ok":true}');

    await controller.stop();
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 9 });
    expect(controller.snapshot().active).toBe(false);
    expect(eventListeners.size).toBe(0);
  });

  it('keeps the controller scoped to the requested tab and preserves state after stopping', async () => {
    const events = [event(), event(), event(), event(), event()];
    const webRequest = {
      onBeforeRequest: events[0], onBeforeSendHeaders: events[1], onHeadersReceived: events[2],
      onCompleted: events[3], onErrorOccurred: events[4],
    };
    const controller = createNetworkCaptureController({ webRequest });
    await controller.start(4, false);
    expect(events[0]!.addListener).toHaveBeenCalledWith(
      expect.any(Function), { urls: ['<all_urls>'], tabId: 4 }, undefined,
    );
    await controller.stop();
    expect(controller.snapshot().requests).toEqual([]);
  });
  it('falls back to Chromium webRequest metadata when CDP attach is unavailable', async () => {
    const onBeforeRequest = event();
    const onBeforeSendHeaders = event();
    const onHeadersReceived = event();
    const onCompleted = event();
    const onErrorOccurred = event();
    const webRequest = {
      onBeforeRequest, onBeforeSendHeaders, onHeadersReceived, onCompleted, onErrorOccurred,
    };
    const debuggerApi = {
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      attach: vi.fn().mockRejectedValue(new Error('Another debugger is already attached')),
      sendCommand: vi.fn(),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const controller = createNetworkCaptureController({ webRequest }, { debugger: debuggerApi });

    const started = await controller.start(31, true);
    expect(started.active).toBe(true);
    expect(started.mode).toBe('chromium-webRequest');
    expect(onBeforeRequest.addListener).toHaveBeenCalledWith(
      expect.any(Function), { urls: ['<all_urls>'], tabId: 31 }, ['requestBody'],
    );

    onBeforeRequest.fire({
      requestId: 'fallback-1', tabId: 31, url: 'https://example.test/api',
      method: 'POST', type: 'xmlhttprequest', timeStamp: 200,
      requestBody: { formData: { prompt: ['hello'], api_key: ['private'] } },
    });
    const record = controller.snapshot().requests[0];
    expect(record?.requestBody).toContain('[REDACTED]');
    expect(record?.requestBody).not.toContain('private');

    await controller.stop();
    expect(controller.snapshot().active).toBe(false);
  });

  it('uses only webRequest when the user explicitly selects that channel', async () => {
    const onBeforeRequest = event();
    const onBeforeSendHeaders = event();
    const onHeadersReceived = event();
    const onCompleted = event();
    const onErrorOccurred = event();
    const webRequest = {
      onBeforeRequest, onBeforeSendHeaders, onHeadersReceived, onCompleted, onErrorOccurred,
    };
    const debuggerApi = {
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      attach: vi.fn(),
      sendCommand: vi.fn(),
      detach: vi.fn(),
    };
    const controller = createNetworkCaptureController({ webRequest }, { debugger: debuggerApi });

    const snapshot = await controller.start(65, true, 'webRequest');
    expect(snapshot.mode).toBe('chromium-webRequest');
    expect(debuggerApi.attach).not.toHaveBeenCalled();
    expect(onBeforeRequest.addListener).toHaveBeenCalled();

    await controller.stop();
  });

  it('does not silently switch from explicitly selected CDP to webRequest after detach', async () => {
    const onBeforeRequest = event();
    const webRequest = {
      onBeforeRequest,
      onBeforeSendHeaders: event(),
      onHeadersReceived: event(),
      onCompleted: event(),
      onErrorOccurred: event(),
    };
    const onEvent = event();
    const onDetach = event();
    const debuggerApi = {
      onEvent, onDetach,
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({}),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const controller = createNetworkCaptureController({ webRequest }, { debugger: debuggerApi });

    const snapshot = await controller.start(67, true, 'cdp');
    expect(snapshot.mode).toBe('chromium-cdp');
    onDetach.fire({ tabId: 67 }, 'canceled_by_user');

    expect(controller.snapshot().active).toBe(false);
    expect(controller.snapshot().mode).toBeNull();
    expect(onBeforeRequest.addListener).not.toHaveBeenCalled();
  });

  it('automatically falls back when CDP is detached by DevTools', async () => {
    const onBeforeRequest = event();
    const onBeforeSendHeaders = event();
    const onHeadersReceived = event();
    const onCompleted = event();
    const onErrorOccurred = event();
    const webRequest = {
      onBeforeRequest, onBeforeSendHeaders, onHeadersReceived, onCompleted, onErrorOccurred,
    };
    const onEvent = event();
    const onDetach = event();
    const debuggerApi = {
      onEvent, onDetach,
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue({}),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const controller = createNetworkCaptureController({ webRequest }, { debugger: debuggerApi });

    const started = await controller.start(66, true);
    expect(started.mode).toBe('chromium-cdp');

    onDetach.fire({ tabId: 66 }, 'canceled_by_user');
    expect(controller.snapshot().active).toBe(true);
    expect(controller.snapshot().mode).toBe('chromium-webRequest');
    expect(onBeforeRequest.addListener).toHaveBeenCalled();

    onBeforeRequest.fire({
      requestId: 'after-devtools', tabId: 66, url: 'https://example.test/after-devtools',
      method: 'GET', type: 'xmlhttprequest', timeStamp: 300,
    });
    expect(controller.snapshot().requests[0]?.id).toBe('after-devtools');

    await controller.stop();
  });

  it('clears requests when automatic capture switches to a different source tab', async () => {
    const eventsA = [event(), event(), event(), event(), event()];
    const eventsB = [event(), event(), event(), event(), event()];
    const createWebRequest = (events: ReturnType<typeof event>[]) => ({
      onBeforeRequest: events[0], onBeforeSendHeaders: events[1], onHeadersReceived: events[2],
      onCompleted: events[3], onErrorOccurred: events[4],
    });
    let currentWebRequest = createWebRequest(eventsA);
    const browserApi = {
      get webRequest() { return currentWebRequest; },
    };
    const controller = createNetworkCaptureController(browserApi);

    await controller.start(41, false);
    eventsA[0]!.fire({
      requestId: 'tab-41', tabId: 41, url: 'https://first.test/api',
      method: 'GET', type: 'xmlhttprequest', timeStamp: 1,
    });
    expect(controller.snapshot().requests).toHaveLength(1);

    currentWebRequest = createWebRequest(eventsB);
    const switched = await controller.start(42, false);
    expect(switched.tabId).toBe(42);
    expect(switched.requests).toHaveLength(0);
    expect(eventsA[0]!.removeListener).toHaveBeenCalledTimes(1);
  });

  it('redacts secrets embedded in raw body strings and caps JSON bodies', async () => {
    const events = [event(), event(), event(), event(), event()];
    const webRequest = {
      onBeforeRequest: events[0], onBeforeSendHeaders: events[1], onHeadersReceived: events[2],
      onCompleted: events[3], onErrorOccurred: events[4],
    };
    const controller = createNetworkCaptureController({ webRequest });
    await controller.start(55, true);

    const raw = new TextEncoder().encode('api_key=raw-secret&password=another-secret').buffer;
    events[0]!.fire({
      requestId: 'raw-body', tabId: 55, url: 'https://example.test/form',
      method: 'POST', type: 'xmlhttprequest', timeStamp: 1,
      requestBody: { raw: [{ bytes: raw }] },
    });
    const rawRecord = controller.snapshot().requests.find((item) => item.id === 'raw-body');
    expect(rawRecord?.requestBody).toContain('[REDACTED]');
    expect(rawRecord?.requestBody).not.toContain('raw-secret');
    expect(rawRecord?.requestBody).not.toContain('another-secret');

    const largeRaw = new TextEncoder().encode(JSON.stringify({ note: 'x'.repeat(40 * 1024) })).buffer;
    events[0]!.fire({
      requestId: 'large-body', tabId: 55, url: 'https://example.test/large',
      method: 'POST', type: 'xmlhttprequest', timeStamp: 2,
      requestBody: { raw: [{ bytes: largeRaw }] },
    });
    const largeRecord = controller.snapshot().requests.find((item) => item.id === 'large-body');
    expect(largeRecord?.requestBody).toContain('[TRUNCATED]');
    expect(new TextEncoder().encode(largeRecord?.requestBody || '').byteLength).toBeLessThanOrEqual(32 * 1024);

    await controller.stop();
  });


});
