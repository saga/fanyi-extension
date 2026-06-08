// Simulate extractBlocks behavior on bankingdive structure
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

const dom = new JSDOM(`<!DOCTYPE html>
<html>
<body class="flush-top article-page news topic- technology">
<article>
  <div class="first-page-pdf">
    <div class="printed-branding">An article from</div>
    <div class="article-title-wrapper">
      <h1 class="display-heading-04">Wells Fargo CEO: AI's effect on employment is 'complicated'</h1>
    </div>
    <div class="byline">
      Published May 28, 2026
    </div>
    <figure class="inside_story">
      <img src="x.jpg" alt="Wells Fargo CEO" />
      <figcaption>Wells Fargo CEO Charlie Scharf is interviewed.</figcaption>
    </figure>
    <p>The bank's biggest AI-related challenge is determining how the technology can transform its business model and how the lender should respond, Charlie Scharf said Wednesday.</p>
  </div>
  <div class="row">
    <div class="article-large-12 columns article-wrapper">
      <div class="print-wrapper">
        <div class=" large medium article-body">
          <p>As the company considers its spending, there are two conversations: "Every part of the company, area by area, how can we do more with less? And then, what are all the things that we want to do to spend to grow the business?" Scharf said.</p>
          <p>Wells Fargo projects <a>this year's non-interest expenses</a> to total $55.7 billion.</p>
        </div>
      </div>
    </div>
  </div>
</article>
</body>
</html>
`);

const { document, NodeFilter } = dom.window;

const DIRECT_SET = new Set(['h1','h2','h3','h4','h5','h6','p','li','dd','blockquote','figcaption']);
const INLINE_SET = new Set(['a','span','b','i','em','strong','u','small','sup','sub','mark','del','ins','code','kbd','abbr','cite','q','time','br','wbr','font','label']);
const SKIP_SET = new Set(['script','style','noscript','svg','link','meta','template','iframe']);
const SEMANTIC_SKIP_TAGS = new Set(['nav','header','footer','aside','form','button','input','select','textarea','option','optgroup','fieldset','legend','menu','menuitem','dialog']);

const blocks = [];
let id = 0;
const seenTexts = new Set();

const article = document.querySelector('article');
const walker = document.createTreeWalker(article, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
  acceptNode: (node) => {
    if (node.nodeType === 3) {
      const text = node.textContent.trim();
      if (text.length < 1) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
    if (!(node instanceof dom.window.Element)) return NodeFilter.FILTER_SKIP;

    const el = node;
    const tag = el.tagName.toLowerCase();
    if (SKIP_SET.has(tag)) return NodeFilter.FILTER_REJECT;
    if (SEMANTIC_SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;

    if (DIRECT_SET.has(tag)) {
      const hasDescendant = el.querySelector(Array.from(DIRECT_SET).join(',')) !== null;
      if (hasDescendant) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    }

    // Check for class-based skip
    const className = (el.className || '').toString().toLowerCase();
    const classList = className.split(/\s+/).filter(Boolean);

    // Inline check
    if (INLINE_SET.has(tag)) {
      return NodeFilter.FILTER_SKIP;
    }
    return NodeFilter.FILTER_SKIP; // skip non-direct-set elements for this test
  }
});

let node;
while ((node = walker.nextNode())) {
  if (node.nodeType === 3) continue;
  const el = node;
  const tag = el.tagName.toLowerCase();
  if (!DIRECT_SET.has(tag)) continue;
  const text = el.textContent.trim();
  if (text.length < 4) continue;
  if (seenTexts.has(text)) {
    console.log(`SKIP DEDUP [${tag}]: ${text.slice(0, 60)}`);
    continue;
  }
  seenTexts.add(text);
  blocks.push({ id: ++id, tag, text: text.slice(0, 80) });
}

console.log(`\nTotal blocks: ${blocks.length}`);
for (const b of blocks) {
  console.log(`  [${b.id}] <${b.tag}> ${b.text}`);
}
