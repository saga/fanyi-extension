import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekTranslationService } from './deepseek';

// Mock streamParser to avoid jsdom ReadableStream issues
const mockParseSSEStream = vi.fn();
vi.mock('./streamParser', () => ({
  parseSSEStream: (...args: any[]) => mockParseSSEStream(...args),
}));

// Mock global fetch
const globalFetch = vi.fn();
Object.defineProperty(globalThis, 'fetch', { value: globalFetch, writable: true });

describe('DeepSeekTranslationService.translateStream', () => {
  let service: DeepSeekTranslationService;

  beforeEach(() => {
    service = new DeepSeekTranslationService('test-api-key');
    vi.clearAllMocks();
  });

  async function consumeStream(stream: AsyncGenerator<string, string, unknown>): Promise<{ values: string[]; returnValue: string }> {
    const values: string[] = [];
    let returnValue = '';
    try {
      while (true) {
        const result = await stream.next();
        if (result.done) {
          returnValue = result.value as string;
          break;
        }
        values.push(result.value);
      }
    } catch (e) {
      throw e;
    }
    return { values, returnValue };
  }

  it('should yield accumulated content for each delta', async () => {
    mockParseSSEStream.mockImplementation(async function* () {
      yield 'Hello';
      yield ' world';
      yield '!';
    });

    const mockResponse = {
      ok: true,
      status: 200,
      body: { getReader: vi.fn() },
      text: vi.fn().mockResolvedValue(''),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'test' }]),
      'en',
      'zh',
      []
    );

    const { values } = await consumeStream(stream);
    expect(values).toEqual(['Hello', 'Hello world', 'Hello world!']);
  });

  it('should set stream=true in request body', async () => {
    mockParseSSEStream.mockImplementation(async function* () {
      yield 'test';
    });

    const mockResponse = {
      ok: true,
      status: 200,
      body: { getReader: vi.fn() },
      text: vi.fn().mockResolvedValue(''),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    await consumeStream(stream);

    const fetchCall = globalFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.stream).toBe(true);
  });

  it('should include Authorization header', async () => {
    mockParseSSEStream.mockImplementation(async function* () {
      yield 'test';
    });

    const mockResponse = {
      ok: true,
      status: 200,
      body: { getReader: vi.fn() },
      text: vi.fn().mockResolvedValue(''),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    await consumeStream(stream);

    const fetchCall = globalFetch.mock.calls[0];
    expect(fetchCall[1].headers.Authorization).toBe('Bearer test-api-key');
  });

  it('should throw on HTTP error', async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      body: null,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    await expect(consumeStream(stream)).rejects.toThrow('DeepSeek API error: HTTP 401');
  });

  it('should throw when response body is null', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      body: null,
      text: vi.fn().mockResolvedValue(''),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    await expect(consumeStream(stream)).rejects.toThrow('response body is null');
  });

  it('should return final content as generator return value', async () => {
    mockParseSSEStream.mockImplementation(async function* () {
      yield 'Hello';
      yield ' world';
    });

    const mockResponse = {
      ok: true,
      status: 200,
      body: { getReader: vi.fn() },
      text: vi.fn().mockResolvedValue(''),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    const { returnValue } = await consumeStream(stream);
    expect(returnValue).toBe('Hello world');
  });

  it('should handle empty stream', async () => {
    mockParseSSEStream.mockImplementation(async function* () {
      // no yields
    });

    const mockResponse = {
      ok: true,
      status: 200,
      body: { getReader: vi.fn() },
      text: vi.fn().mockResolvedValue(''),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    const { values } = await consumeStream(stream);
    expect(values).toEqual([]);
  });

  it('should handle glossary in request', async () => {
    mockParseSSEStream.mockImplementation(async function* () {
      yield 'test';
    });

    const mockResponse = {
      ok: true,
      status: 200,
      body: { getReader: vi.fn() },
      text: vi.fn().mockResolvedValue(''),
    };
    globalFetch.mockResolvedValue(mockResponse);

    const glossary = [{ term: 'React', translation: 'React' }];
    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'React is great' }]),
      'en',
      'zh',
      glossary
    );

    await consumeStream(stream);

    const fetchCall = globalFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.messages[0].content).toContain('React');
  });

  it('should handle network errors', async () => {
    globalFetch.mockRejectedValue(new TypeError('fetch failed'));

    const stream = service.translateStream(
      JSON.stringify([{ id: 'b1', text: 'hello' }]),
      'en',
      'zh',
      []
    );

    await expect(consumeStream(stream)).rejects.toThrow();
  });
});
