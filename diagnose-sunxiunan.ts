import { chromium } from 'playwright';
import { JSDOM } from 'jsdom';
import { detectArticleRoot } from './src/entrypoints/utils/contentDetector';
import { extractBlocks } from './src/entrypoints/utils/blockExtractor';

async function main() {
  const context = await chromium.launchPersistentContext('/tmp/.playwright-profile-sun', {
    headless: true,
  });
  const page = await context.newPage();
  await page.goto('https://s.sunxiunan.com/article/334', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  const html = await page.content();
  const { window } = new JSDOM(html);
  const { document } = window;
  // walker.ts / rules.ts 内部使用全局 document / window / NodeFilter 等 API，在 Node 环境下需注入全局
  (globalThis as any).window = window;
  (globalThis as any).document = document;
  (globalThis as any).NodeFilter = window.NodeFilter;
  (globalThis as any).Node = window.Node;
  (globalThis as any).Element = window.Element;
  (globalThis as any).HTMLElement = window.HTMLElement;
  (globalThis as any).Text = window.Text;

  console.log('html lang:', document.documentElement.lang);
  console.log('title:', document.title);
  console.log('body text length:', (document.body.textContent || '').length);
  console.log('body children count:', document.body.children.length);

  console.log('\nBody children:');
  Array.from(document.body.children).forEach((el, i) => {
    const cls = el.className?.split(/\s+/).slice(0, 3).join('.') || '';
    const id = el.id || '';
    console.log(`  [${i}] ${el.tagName}.${cls}#${id} textLen=${(el.textContent || '').length}`);
  });

  const main = document.querySelector('main, article, .content, .article, .post, [class*="content"]');
  console.log('\nMain/article-like element:', main ? `${main.tagName}.${main.className?.split(/\s+/).slice(0,3).join('.')} textLen=${(main.textContent||'').length}` : 'none');

  const root = detectArticleRoot(document);
  console.log('\nDetected root:', root ? `${root.tagName}.${root.className?.split(/\s+/).slice(0,3).join('.')} textLen=${(root.textContent||'').length}` : 'null');

  const blocks = extractBlocks(root || document);
  console.log('\nExtracted blocks:', blocks.length);
  console.log('Extracted total text length:', blocks.reduce((sum, b) => sum + b.text.length, 0));
  blocks.slice(0, 10).forEach((b, i) => {
    console.log(`  [${i}] ${b.tag} ${b.text.slice(0, 100).replace(/\n/g, ' ')}...`);
  });
  console.log('  ...');
  blocks.slice(-5).forEach((b, i) => {
    console.log(`  [${blocks.length - 5 + i}] ${b.tag} ${b.text.slice(0, 100).replace(/\n/g, ' ')}...`);
  });

  // 测试 Readability 单独返回的内容长度
  const { Readability } = await import('@mozilla/readability');
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  const cloneDoc = document.implementation.createHTMLDocument(document.title);
  cloneDoc.documentElement.replaceWith(clone);
  const reader = new Readability(cloneDoc);
  const article = reader.parse();
  console.log('\nReadability title:', article?.title);
  console.log('Readability textContent length:', article?.textContent?.length ?? 0);

  await context.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
