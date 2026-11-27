/**
 * Per-tab Network Inspector.
 *
 * Firefox (including Android) uses the background webRequest API. Chromium uses
 * the DevTools Protocol Network domain through chrome.debugger and falls back to
 * webRequest metadata when CDP cannot attach. The side panel starts it automatically.
 */
export type NetworkCaptureMode = 'firefox-webRequest' | 'chromium-cdp' | 'chromium-webRequest';

export interface NetworkRequestRecord {
  id: string;
  url: string;
  method: string;
  resourceType?: string;
  startedAt: number;
  durationMs?: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  bodyTruncated?: boolean;
}

export interface NetworkCaptureSnapshot {
  active: boolean;
  tabId: number | null;
  startedAt: number | null;
  includeBodies: boolean;
  mode: NetworkCaptureMode | null;
  requests: NetworkRequestRecord[];
}

const MAX_REQUESTS = 150;
const MAX_BODY_BYTES = 32 * 1024;
const SENSITIVE_KEY = /(?:authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|credential|session)/i;
const TEXT_MIME = /(?:^text\/|json|xml|javascript|x-www-form-urlencoded|graphql)/i;

function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch {
    return input;
  }
}

function sanitizeText(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s"'&,]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|session|authorization|credential)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|credential|session)["']?\s*[:=]\s*["']?)[^"'&,}\s]+(["']?)/gi, '$1[REDACTED]$2');
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[MAX_DEPTH]';
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeValue(item, depth + 1);
    }
    return result;
  }
  return value;
}

function limitBodyBytes(value: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= MAX_BODY_BYTES) return value;
  const suffix = '\n[TRUNCATED]';
  const suffixBytes = encoder.encode(suffix).byteLength;
  return new TextDecoder().decode(bytes.subarray(0, MAX_BODY_BYTES - suffixBytes)) + suffix;
}

function sanitizeBody(value: unknown): string | undefined {
  if (value == null) return undefined;
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  if (!raw) return undefined;
  let sanitized: string;
  try {
    sanitized = JSON.stringify(sanitizeValue(JSON.parse(raw))) ?? raw;
  } catch {
    sanitized = sanitizeText(raw);
  }
  return limitBodyBytes(sanitized);
}

function sanitizeHeaders(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {};
  const result: Record<string, string> = {};
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item.name !== 'string') continue;
      result[item.name] = SENSITIVE_KEY.test(item.name) ? '[REDACTED]' : String(item.value ?? '');
    }
    return result;
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : String(value ?? '');
  }
  return result;
}

function decodeBytes(chunks: Uint8Array[], total: number): string {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.length, total - offset));
    bytes.set(part, offset);
    offset += part.length;
    if (offset >= total) break;
  }
  return new TextDecoder().decode(bytes);
}

function isTextMime(mimeType?: string): boolean {
  return !!mimeType && TEXT_MIME.test(mimeType);
}

function cloneSnapshot(state: NetworkCaptureSnapshot): NetworkCaptureSnapshot {
  return {
    ...state,
    requests: state.requests.map((item) => ({ ...item })),
  };
}

type Listener = (snapshot: NetworkCaptureSnapshot) => void;

export class NetworkCaptureController {
  private state: NetworkCaptureSnapshot = {
    active: false, tabId: null, startedAt: null, includeBodies: false, mode: null, requests: [],
  };
  private listeners = new Set<Listener>();
  private webListeners: Array<{ event: any; listener: (...args: any[]) => unknown }> = [];
  private requestById = new Map<string, NetworkRequestRecord>();
  private streams = new Map<string, { filter: any; chunks: Uint8Array[]; bytes: number }>();
  private chromeApi: any;
  private browserApi: any;
  private debuggerTarget: { tabId: number } | null = null;
  private debuggerEventListener?: (...args: any[]) => void;
  private debuggerDetachListener?: (...args: any[]) => void;
  private stopping = false;
  private lastCaptureTabId: number | null = null;
  private sequence = 0;

  constructor(browserApi: any, chromeApi?: any) {
    this.browserApi = browserApi;
    this.chromeApi = chromeApi;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): NetworkCaptureSnapshot {
    return cloneSnapshot(this.state);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private upsert(record: NetworkRequestRecord): void {
    this.requestById.set(record.id, record);
    this.state.requests = [...this.requestById.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MAX_REQUESTS);
    const retained = new Set(this.state.requests.map((item) => item.id));
    for (const id of this.requestById.keys()) {
      if (!retained.has(id)) this.requestById.delete(id);
    }
    this.emit();
  }

  async start(tabId: number, includeBodies = false): Promise<NetworkCaptureSnapshot> {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('无效的标签页 ID');
    await this.stop();

    // 不同来源标签页之间不复用旧请求，避免侧栏切换后把上一页的数据混在一起。
    if (this.lastCaptureTabId !== null && this.lastCaptureTabId !== tabId) {
      this.requestById.clear();
      this.state.requests = [];
    }
    this.lastCaptureTabId = tabId;

    const webRequest = this.browserApi?.webRequest;
    const chromeDebugger = this.chromeApi?.debugger;
    const canUseDebugger = typeof chromeDebugger?.attach === 'function'
      && typeof chromeDebugger?.sendCommand === 'function';
    const canUseWebRequest = typeof webRequest?.onBeforeRequest?.addListener === 'function';

    // Chromium 优先使用 CDP（包含响应正文）；attach 失败或 DevTools 接管时自动降级。
    if (canUseDebugger) {
      try {
        await this.startChromium(chromeDebugger, tabId, includeBodies);
        return this.snapshot();
      } catch (error) {
        if (!canUseWebRequest) throw error;
        this.startWebRequest(webRequest, tabId, includeBodies, 'chromium-webRequest');
        return this.snapshot();
      }
    }

    if (canUseWebRequest) {
      const isFirefox = typeof this.browserApi?.runtime?.getBrowserInfo === 'function';
      const mode: NetworkCaptureMode = isFirefox ? 'firefox-webRequest' : 'chromium-webRequest';
      this.startWebRequest(webRequest, tabId, includeBodies, mode);
      return this.snapshot();
    }

    throw new Error('当前浏览器没有可用的网络请求捕获 API');
  }

  private startWebRequest(
    webRequest: any,
    tabId: number,
    includeBodies: boolean,
    mode: NetworkCaptureMode,
  ): void {
    this.state = {
      active: true, tabId, startedAt: Date.now(), includeBodies,
      mode, requests: this.state.requests,
    };
    this.registerWebRequestListeners(webRequest, tabId, includeBodies);
    this.emit();
  }

  private registerWebRequestListeners(web: any, tabId: number, includeBodies: boolean): void {
    const filter = { urls: ['<all_urls>'], tabId };
    const add = (event: any, listener: (...args: any[]) => unknown, extra?: string[]) => {
      event.addListener(listener, filter, extra);
      this.webListeners.push({ event, listener });
    };

    const canFilterResponse = includeBodies && typeof web.filterResponseData === 'function';
    add(web.onBeforeRequest, (details: any) => {
      if (!this.matchesTab(details.tabId)) return;
      const id = String(details.requestId);
      const record: NetworkRequestRecord = {
        id, url: sanitizeUrl(details.url), method: details.method || 'GET',
        resourceType: details.type, startedAt: details.timeStamp || Date.now(),
      };
      if (includeBodies && details.requestBody) {
        record.requestBody = sanitizeBody({
          formData: details.requestBody.formData,
          raw: details.requestBody.raw?.map((part: any) => {
            try {
              const bytes = part.bytes ? new Uint8Array(part.bytes) : null;
              return bytes ? new TextDecoder().decode(bytes) : undefined;
            } catch { return undefined; }
          }).filter(Boolean),
        });
      }
      this.upsert(record);

      // Firefox's filterResponseData is the response-body API on Android too.
      // Always pass bytes through; only retain a small text/JSON preview.
      if (includeBodies && details.type === 'xmlhttprequest' && typeof web.filterResponseData === 'function') {
        try {
          const stream = web.filterResponseData(id);
          const capture = { filter: stream, chunks: [] as Uint8Array[], bytes: 0 };
          this.streams.set(id, capture);
          stream.ondata = (event: any) => {
            const bytes = new Uint8Array(event.data);
            if (capture.bytes < MAX_BODY_BYTES) {
              const part = bytes.slice(0, Math.min(bytes.length, MAX_BODY_BYTES - capture.bytes));
              capture.chunks.push(part);
              capture.bytes += part.length;
            }
            stream.write(event.data);
          };
          stream.onstop = () => {
            const current = this.requestById.get(id);
            if (current && isTextMime(current.mimeType)) {
              current.responseBody = sanitizeBody(decodeBytes(capture.chunks, capture.bytes));
              current.bodyTruncated = capture.bytes >= MAX_BODY_BYTES;
              this.upsert(current);
            }
            this.streams.delete(id);
            try { stream.close(); } catch { /* stream already closed */ }
          };
          stream.onerror = () => {
            this.streams.delete(id);
            try { stream.disconnect(); } catch { /* ignore */ }
          };
        } catch {
          // Some Firefox contexts expose webRequest but not filterResponseData.
        }
      }
    }, includeBodies ? (canFilterResponse ? ['blocking', 'requestBody'] : ['requestBody']) : undefined);

    add(web.onBeforeSendHeaders, (details: any) => {
      const record = this.requestById.get(String(details.requestId));
      if (!record) return;
      record.requestHeaders = sanitizeHeaders(details.requestHeaders);
      this.upsert(record);
    }, ['requestHeaders']);

    add(web.onHeadersReceived, (details: any) => {
      const record = this.requestById.get(String(details.requestId));
      if (!record) return;
      record.status = details.statusCode;
      record.statusText = details.statusLine;
      record.responseHeaders = sanitizeHeaders(details.responseHeaders);
      record.mimeType = details.responseHeaders?.find((header: any) =>
        String(header.name).toLowerCase() === 'content-type')?.value?.split(';')[0];
      this.upsert(record);
    }, ['responseHeaders']);

    add(web.onCompleted, (details: any) => {
      const record = this.requestById.get(String(details.requestId));
      if (!record) return;
      record.status = details.statusCode;
      record.durationMs = Math.max(0, (details.timeStamp || Date.now()) - record.startedAt);
      this.upsert(record);
    });

    add(web.onErrorOccurred, (details: any) => {
      const record = this.requestById.get(String(details.requestId));
      if (!record) return;
      record.error = details.error || 'Network request failed';
      record.durationMs = Math.max(0, (details.timeStamp || Date.now()) - record.startedAt);
      this.upsert(record);
    });
  }

  private matchesTab(tabId: number): boolean {
    return this.state.active && this.state.tabId === tabId;
  }

  private async startChromium(debuggerApi: any, tabId: number, includeBodies: boolean): Promise<void> {
    const target = { tabId };
    this.debuggerTarget = target;
    this.state = {
      active: true, tabId, startedAt: Date.now(), includeBodies,
      mode: 'chromium-cdp', requests: this.state.requests,
    };
    this.debuggerEventListener = (source: any, method: string, params: any) => {
      if (source?.tabId !== tabId || !this.state.active) return;
      const id = String(params?.requestId ?? '');
      if (!id) return;
      if (method === 'Network.requestWillBeSent') {
        const request = params.request || {};
        const record: NetworkRequestRecord = {
          id, url: sanitizeUrl(String(request.url || '')), method: request.method || 'GET',
          resourceType: params.type, startedAt: Date.now(),
          requestHeaders: sanitizeHeaders(request.headers),
          ...(includeBodies && request.postData ? { requestBody: sanitizeBody(request.postData) } : {}),
        };
        this.upsert(record);
      } else if (method === 'Network.responseReceived') {
        const record = this.requestById.get(id);
        if (!record) return;
        const response = params.response || {};
        record.status = response.status;
        record.statusText = response.statusText;
        record.mimeType = response.mimeType;
        record.responseHeaders = sanitizeHeaders(response.headers);
        this.upsert(record);
      } else if (method === 'Network.loadingFinished') {
        const record = this.requestById.get(id);
        if (!record) return;
        record.durationMs = Math.max(0, Date.now() - record.startedAt);
        this.upsert(record);
        if (includeBodies && isTextMime(record.mimeType)
          && Number(params.encodedDataLength || 0) <= MAX_BODY_BYTES) {
          void debuggerApi.sendCommand(target, 'Network.getResponseBody', { requestId: id })
            .then((result: any) => {
              const current = this.requestById.get(id);
              if (!current || !result || typeof result.body !== 'string') return;
              let body = result.body;
              if (result.base64Encoded) {
                try {
                  const binary = atob(body);
                  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
                  body = new TextDecoder().decode(bytes);
                } catch { return; }
              }
              current.responseBody = sanitizeBody(body);
              this.upsert(current);
            }).catch(() => {});
        }
      } else if (method === 'Network.loadingFailed') {
        const record = this.requestById.get(id);
        if (!record) return;
        record.error = params.errorText || 'Network request failed';
        record.durationMs = Math.max(0, Date.now() - record.startedAt);
        this.upsert(record);
      }
    };
    this.debuggerDetachListener = (source: any, reason?: string) => {
      if (source?.tabId !== tabId || this.stopping) return;
      this.removeDebuggerListeners(debuggerApi);
      this.debuggerTarget = null;
      this.state.active = false;
      this.state.mode = null;

      // DevTools 接管同一标签页时 Chrome 会断开扩展的 CDP 会话；
      // 若标签页仍存在且 webRequest 可用，自动切换到只读元数据采集。
      const webRequest = this.browserApi?.webRequest;
      if (reason !== 'target_closed' && typeof webRequest?.onBeforeRequest?.addListener === 'function') {
        try {
          this.startWebRequest(webRequest, tabId, this.state.includeBodies, 'chromium-webRequest');
          return;
        } catch {
          /* 自动降级失败时保持停止状态 */
        }
      }
      this.state.tabId = null;
      this.state.startedAt = null;
      this.state.includeBodies = false;
      this.emit();
    };
    debuggerApi.onEvent?.addListener(this.debuggerEventListener);
    debuggerApi.onDetach?.addListener(this.debuggerDetachListener);
    let attached = false;
    try {
      await debuggerApi.attach(target, '1.3');
      attached = true;
      await debuggerApi.sendCommand(target, 'Network.enable', {
        maxTotalBufferSize: 2 * 1024 * 1024,
        maxResourceBufferSize: MAX_BODY_BYTES,
      });
      this.emit();
    } catch (error) {
      this.state.active = false;
      this.state.mode = null;
      this.debuggerTarget = null;
      this.removeDebuggerListeners(debuggerApi);
      if (attached) {
        try { await debuggerApi.detach(target); } catch { /* attach partially failed */ }
      }
      throw new Error(error instanceof Error ? error.message : '无法连接 Chrome Debugger');
    }
  }

  private removeDebuggerListeners(debuggerApi: any): void {
    if (this.debuggerEventListener) debuggerApi.onEvent?.removeListener(this.debuggerEventListener);
    if (this.debuggerDetachListener) debuggerApi.onDetach?.removeListener(this.debuggerDetachListener);
    this.debuggerEventListener = undefined;
    this.debuggerDetachListener = undefined;
  }

  async stop(): Promise<NetworkCaptureSnapshot> {
    this.stopping = true;
    for (const { event, listener } of this.webListeners) {
      try { event.removeListener(listener); } catch { /* listener already removed */ }
    }
    this.webListeners = [];
    for (const stream of this.streams.values()) {
      try { stream.filter.disconnect(); } catch { /* request already completed */ }
    }
    this.streams.clear();

    const target = this.debuggerTarget;
    const debuggerApi = this.chromeApi?.debugger;
    if (target && debuggerApi) {
      this.removeDebuggerListeners(debuggerApi);
      try { await debuggerApi.detach(target); } catch { /* tab closed or already detached */ }
    }
    this.debuggerTarget = null;
    this.state.active = false;
    this.state.tabId = null;
    this.state.startedAt = null;
    this.state.includeBodies = false;
    this.state.mode = null;
    this.stopping = false;
    this.emit();
    return this.snapshot();
  }

  clear(): NetworkCaptureSnapshot {
    this.requestById.clear();
    this.state.requests = [];
    this.emit();
    return this.snapshot();
  }
}

export function createNetworkCaptureController(browserApi: any, chromeApi?: any): NetworkCaptureController {
  return new NetworkCaptureController(browserApi, chromeApi);
}
