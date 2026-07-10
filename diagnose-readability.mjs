import { chromium } from 'playwright';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET = 'https://developers.googleblog.com/litertjs-googles-high-performance-web-ai-inference/';

const context = await chromium.launchPersistentContext(path.join(__dirname, '.playwright-profile'), {
  headless: false,
});

const page = context.pages()[0] || await context.newPage();
console.log(`Navigating to ${TARGET}`);
await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

const html = await page.content();
console.log('HTML length:', html.length);

const dom = new JSDOM(html, { url: TARGET });
const doc = dom.window.document;

const reader = new Readability(doc);
const article = reader.parse();

if (!article) {
  console.log('Readability failed to parse article');
} else {
  console.log('\n=== Readability result ===');
  console.log('Title:', article.title);
  console.log('Byline:', article.byline);
  console.log('Excerpt:', article.excerpt);
  console.log('Content length:', article.content?.length || 0);
  console.log('Text content length:', article.textContent?.length || 0);
  console.log('\nFirst 1000 chars of textContent:');
  console.log(article.textContent?.slice(0, 1000));
}

await context.close();
