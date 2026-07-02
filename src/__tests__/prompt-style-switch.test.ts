import { describe, it, expect } from 'vitest';
import { buildSystemContent, type PromptStyle } from '../entrypoints/service/deepseek';

/**
 * PromptStyle 文风切换测试。
 *
 * 注意：fanyi-extension 的 buildSystemContent 签名与 vocal-saga 不同：
 *   (sourceLang, targetLang, sitePrompt?, glossary?, style?)
 * sitePrompt 在 glossary 之前。
 */
describe('buildSystemContent prompt style 切换', () => {
  const sourceLang = 'en';
  const targetLang = 'zh';

  it('default 风格包含通用直译指令', () => {
    // sitePrompt=undefined, glossary=undefined, style='default'
    const content = buildSystemContent(sourceLang, targetLang, undefined, undefined, 'default');
    expect(content).toContain('Translate English to Simplified Chinese');
    expect(content).toContain('Return {"translations":[{"id":"x","translated_text":"y"}]}');
    // 不应包含文学风格标签
    expect(content).not.toContain('<role_definition>');
    expect(content).not.toContain('Jin Yong');
    expect(content).not.toContain('Acheng');
    expect(content).not.toContain('Wang Xiaobo');
  });

  it('jinyong 风格包含武侠标签', () => {
    const content = buildSystemContent(sourceLang, targetLang, undefined, undefined, 'jinyong');
    expect(content).toContain('<role_definition>');
    expect(content).toContain('Jin Yong');
    expect(content).toContain('金庸');
    expect(content).toContain('<wuxia_style_profile>');
    expect(content).toContain('<output_format>');
  });

  it('acheng 风格包含阿城标签', () => {
    const content = buildSystemContent(sourceLang, targetLang, undefined, undefined, 'acheng');
    expect(content).toContain('<role_definition>');
    expect(content).toContain('Acheng');
    expect(content).toContain('阿城');
    expect(content).toContain('<acheng_style_profile>');
    expect(content).toContain('<output_format>');
  });

  it('wangxiaobo 风格包含王小波标签', () => {
    const content = buildSystemContent(sourceLang, targetLang, undefined, undefined, 'wangxiaobo');
    expect(content).toContain('<role_definition>');
    expect(content).toContain('Wang Xiaobo');
    expect(content).toContain('王小波');
    expect(content).toContain('<wangxiaobo_style_profile>');
    expect(content).toContain('<output_format>');
  });

  it('不传 style 默认使用通用直译', () => {
    // 不传 style 参数 → 走 default 分支
    const content = buildSystemContent(sourceLang, targetLang, undefined);
    expect(content).toContain('Translate English to Simplified Chinese');
    expect(content).not.toContain('<role_definition>');
  });

  it('glossary 在 default 风格中使用 Preserve only proper nouns', () => {
    const glossary = { document_terms: ['React', 'Vue'] };
    const content = buildSystemContent(sourceLang, targetLang, undefined, glossary, 'default');
    expect(content).toContain('Preserve only proper nouns');
    expect(content).toContain('React');
    expect(content).toContain('Vue');
  });

  it('glossary 在 jinyong 风格中使用 <glossary> 标签', () => {
    const glossary = { document_terms: ['React', 'Vue'] };
    const content = buildSystemContent(sourceLang, targetLang, undefined, glossary, 'jinyong');
    expect(content).toContain('<glossary>');
    expect(content).toContain('React');
    expect(content).toContain('Vue');
  });

  it('glossary 在 acheng 风格中使用 <glossary> 标签', () => {
    const glossary = { document_terms: ['React', 'Vue'] };
    const content = buildSystemContent(sourceLang, targetLang, undefined, glossary, 'acheng');
    expect(content).toContain('<glossary>');
    expect(content).toContain('React');
    expect(content).toContain('Vue');
  });

  it('glossary 在 wangxiaobo 风格中使用 <glossary> 标签', () => {
    const glossary = { document_terms: ['React', 'Vue'] };
    const content = buildSystemContent(sourceLang, targetLang, undefined, glossary, 'wangxiaobo');
    expect(content).toContain('<glossary>');
    expect(content).toContain('React');
    expect(content).toContain('Vue');
  });

  it('各种风格都包含 JSON 输出格式约束', () => {
    const styles: PromptStyle[] = ['default', 'jinyong', 'acheng', 'wangxiaobo'];
    for (const style of styles) {
      const content = buildSystemContent(sourceLang, targetLang, undefined, undefined, style);
      expect(content).toMatch(/translated_text/);
    }
  });

  it('文学风格正确追加 sitePrompt', () => {
    // fanyi-extension 特有：文学风格 prompt 不接受 sitePrompt 参数，
    // 需要在调用后追加 Site-specific rules
    const sitePrompt = 'Skip code blocks on github.com';
    const styles: PromptStyle[] = ['jinyong', 'acheng', 'wangxiaobo'];
    for (const style of styles) {
      const content = buildSystemContent(sourceLang, targetLang, sitePrompt, undefined, style);
      expect(content).toContain('Site-specific rules:');
      expect(content).toContain(sitePrompt);
    }
  });

  it('default 风格正确追加 sitePrompt', () => {
    const sitePrompt = 'Skip code blocks on github.com';
    const content = buildSystemContent(sourceLang, targetLang, sitePrompt, undefined, 'default');
    expect(content).toContain('Site-specific rules:');
    expect(content).toContain(sitePrompt);
  });
});
