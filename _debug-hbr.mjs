// Inline reproduction of HBR DOM walk
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`
<!DOCTYPE html>
<html>
<body>
<article class="ArticleWrapper-module-scss-module__B-Qtaa__wrapper">
  <div class="Standard-module-scss-module__yt85fq__container">
    <div class="Standard-module-scss-module__yt85fq__content">
      <h3 class="Subheader-module-scss-module__ZOTTua__subheader Subheader-module-scss-module__ZOTTua__h3 undefined">
        <strong>Efficiencies</strong>
      </h3>
      <p class="Paragraph-module-scss-module__UwInRW__text">
        Many individuals and teams are using AI to make current business processes more efficient, such as automating painful parts of recruitment, summarizing notes, trimming costs, curating relevant materials and drafting business templates: "The most useful way I've used AI at work so far."
      </p>
    </div>
  </div>
</article>
</body>
</html>
`, { url: 'https://hbr.org/2026/06/how-people-are-really-using-ai-in-2026' });

const { document, NodeFilter } = dom.window;

const DIRECT_SET = new Set(['h1','h2','h3','h4','h5','h6','p','li','dd','blockquote','figcaption']);
const SKIP_SET = new Set(['html','body','script','style','noscript','iframe','input','textarea','select','button','code','pre','dt','td','th','caption']);
const SEMANTIC_SKIP_TAGS = new Set(['header','footer','aside','nav']);
const INLINE_SET = new Set(['a','b','strong','span','em','i','u','small','sub','sup','font','mark','cite','q','abbr','time','ruby','bdi','bdo','img','br','wbr','svg']);
const SKIP_CLASS_PATTERNS = ['header','ad','sponsored','sidebar','nav','footer','related','comment'];

function shouldSkipByClass(el) {
  if (!el.className || typeof el.className !== 'string') return false;
  const className = el.className.toLowerCase();
  const classList = className.split(/\s+/);
  return SKIP_CLASS_PATTERNS.some(pattern =>
    classList.some(cls =>
      cls === pattern ||
      cls.startsWith(pattern + '-') ||
      cls.startsWith(pattern + '_') ||
      cls.endsWith('-' + pattern) ||
      cls.endsWith('_' + pattern)
    )
  );
}

function isValidText(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 3 || t.length >= 3072) return false;
  if (t.length < 25 && /^[A-Z0-9\s]+$/.test(t) && !/^[0-9\s]+$/.test(t)) return false;
  return true;
}

function grabNode(node) {
  if (node.nodeType === 3) return null;
  if (!(node instanceof dom.window.Element)) return null;
  const el = node;
  const tag = el.tagName.toLowerCase();
  if (SKIP_SET.has(tag)) return null;
  if (SEMANTIC_SKIP_TAGS.has(tag)) return null;
  if (shouldSkipByClass(el)) return null;

  if (DIRECT_SET.has(tag)) {
    const hasDesc = el.querySelector(Array.from(DIRECT_SET).join(',')) !== null;
    if (hasDesc) return null;
    return isValidText(el.textContent) ? el : null;
  }
  if (INLINE_SET.has(tag)) return null;
  return null;
}

const article = document.querySelector('article');
const walker = document.createTreeWalker(article, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
  acceptNode: (node) => {
    if (node.nodeType === 3) {
      // Check parent
      const parent = node.parentElement;
      if (parent && INLINE_SET.has(parent.tagName.toLowerCase())) {
        return NodeFilter.FILTER_REJECT;  // Don't dive into inline
      }
      return NodeFilter.FILTER_ACCEPT;
    }
    if (node instanceof dom.window.Element) {
      const tag = node.tagName.toLowerCase();
      if (shouldSkipByClass(node)) return NodeFilter.FILTER_REJECT;
      if (SKIP_SET.has(tag)) return NodeFilter.FILTER_REJECT;
      if (SEMANTIC_SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
      if (DIRECT_SET.has(tag)) {
        const hasDesc = node.querySelector(Array.from(DIRECT_SET).join(',')) !== null;
        if (hasDesc) return NodeFilter.FILTER_SKIP;
        if (isValidText(node.textContent)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
      if (INLINE_SET.has(tag)) return NodeFilter.FILTER_REJECT;  // Don't accept inline
      return NodeFilter.FILTER_SKIP;
    }
    return NodeFilter.FILTER_SKIP;
  }
});

const blocks = [];
let cur;
while ((cur = walker.nextNode())) {
  const grabbed = grabNode(cur);
  if (grabbed) {
    const text = grabbed.textContent.trim();
    if (text) {
      blocks.push({ tag: grabbed.tagName, text });
    }
  }
}
console.log('Blocks:');
for (const b of blocks) {
  console.log(`  ${b.tag}: ${b.text.slice(0, 80)}`);
}
console.log(`\nTotal: ${blocks.length}`);
console.log(`Efficiencies: ${blocks.some(b => b.text === 'Efficiencies') ? 'YES' : 'NO'}`);
console.log(`Many individuals: ${blocks.some(b => b.text.startsWith('Many individuals')) ? 'YES' : 'NO'}`);
