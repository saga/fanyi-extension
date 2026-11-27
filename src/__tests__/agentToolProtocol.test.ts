import { describe, expect, it } from 'vitest';
import { buildAgentToolInstructions, parseAgentToolRequest, validateAgentToolRequest } from '../entrypoints/utils/agentToolProtocol';

describe('Agent tool protocol', () => {
  it('parses only explicit tool-call JSON, not ordinary JSON replies', () => {
    expect(parseAgentToolRequest('{"answer":"ok"}')).toBeNull();
    expect(parseAgentToolRequest('{"type":"agent_tool_call","tool":"page.inspect","arguments":{},"reason":"检查页面内容"}'))
      .toEqual({ tool: 'page.inspect', arguments: {}, reason: '检查页面内容' });
  });

  it('accepts an explicit Firefox container navigation request', () => {
    expect(validateAgentToolRequest({
      tool: 'browser.containers.open',
      arguments: { url: 'https://example.com/path', identityName: 'Work' },
      reason: '在工作容器中打开文档',
    }).tool).toBe('browser.containers.open');
  });

  it('rejects unsupported tools and non-HTTP container URLs', () => {
    expect(() => validateAgentToolRequest({ tool: 'page.eval', arguments: { source: 'alert(1)' }, reason: 'x' })).toThrow(/不支持/);
    expect(() => validateAgentToolRequest({
      tool: 'browser.containers.open', arguments: { url: 'javascript:alert(1)', identityName: 'Work' }, reason: 'x',
    })).toThrow(/HTTP/);
  });

  it('rejects oversized whole tool requests before processing arguments', () => {
    expect(() => validateAgentToolRequest({
      tool: 'page.inspect',
      arguments: { ignored: 'x'.repeat(33000) },
      reason: '检查页面',
    })).toThrow(/32 KB/);
  });

  it('requires RP ID and a server challenge for passkey operations', () => {
    expect(() => validateAgentToolRequest({
      tool: 'webauthn.create', arguments: { options: { rp: { id: 'example.com' }, user: { id: 'dQ==' } } }, reason: '注册',
    })).toThrow(/challenge/);
    expect(() => validateAgentToolRequest({
      tool: 'webauthn.get', arguments: { options: { rpId: 'https://example.com', challenge: 'YQ==' } }, reason: '认证',
    })).toThrow(/RP ID/);
  });

  it('requires complete server-issued WebAuthn registration fields', () => {
    expect(() => validateAgentToolRequest({
      tool: 'webauthn.create',
      arguments: {
        options: {
          rp: { id: 'example.com' },
          user: { id: 'dXNlcg==', name: 'user@example.com', displayName: 'Example User' },
          challenge: 'Y2hhbGxlbmdl',
        },
      },
      reason: '注册 Passkey',
    })).toThrow(/RP 名称/);

    expect(() => validateAgentToolRequest({
      tool: 'webauthn.create',
      arguments: {
        options: {
          rp: { id: 'example.com', name: 'Example' },
          user: { id: 'dXNlcg==', name: 'user@example.com' },
          challenge: 'Y2hhbGxlbmdl',
        },
      },
      reason: '注册 Passkey',
    })).toThrow(/displayName/);
  });

  it('rejects credential-bearing URLs for container tabs', () => {
    expect(() => validateAgentToolRequest({
      tool: 'browser.containers.open',
      arguments: { url: 'https://user:password@example.com', identityName: 'Work' },
      reason: '打开页面',
    })).toThrow(/账号或密码/);
  });

  it('limits serialized WebAuthn options and documents the approval boundary', () => {
    expect(buildAgentToolInstructions()).toContain('用户都必须');
    expect(() => validateAgentToolRequest({
      tool: 'webauthn.get',
      arguments: { options: { rpId: 'example.com', challenge: 'YQ==', note: 'x'.repeat(25000) } },
      reason: '认证',
    })).toThrow(/24 KB/);
  });
});
