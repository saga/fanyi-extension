
import { JSDOM } from 'jsdom';
import fs from 'fs';

const html = fs.readFileSync('./sample2.html', 'utf8');
const dom = new JSDOM(html);
const { document, NodeFilter } = dom.window;

console.log('=== 搜索目标文本 ===\n');

// 寻找标题
const title = 'From Gemma 4 to DeepSeek V4, How New Open-Weight LLMs Are Reducing Long-Context Costs';
const paragraph = 'After a short family break, I am excited to be back';

function findText(text) {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
  );
  
  let node;
  const results = [];
  
  while (node = walker.nextNode()) {
    if (node.textContent && node.textContent.includes(text)) {
      results.push(node);
    }
  }
  
  return results;
}

const titleNodes = findText(title);
const paraNodes = findText(paragraph);

console.log(`找到标题匹配: ${titleNodes.length} 个`);
console.log(`找到段落匹配: ${paraNodes.length} 个`);

if (titleNodes.length > 0) {
  console.log('\n=== 标题元素信息 ===');
  titleNodes.forEach((node, i) => {
    console.log(`\n匹配 ${i + 1}:`);
    console.log('节点类型:', node.nodeType === 1 ? 'ELEMENT' : 'TEXT');
    if (node.nodeType === 1) {
      console.log('标签:', node.tagName);
      console.log('class:', node.className);
    }
    
    // 找到父元素
    let parent = node.nodeType === 3 ? node.parentElement : node;
    console.log('\n祖先链:');
    let level = 0;
    while (parent && level < 10) {
      console.log(`${'  '.repeat(level)}<${parent.tagName.toLowerCase()} class="${parent.className}" id="${parent.id}">`);
      parent = parent.parentElement;
      level++;
    }
  });
}

if (paraNodes.length > 0) {
  console.log('\n=== 段落元素信息 ===');
  paraNodes.forEach((node, i) => {
    console.log(`\n匹配 ${i + 1}:`);
    console.log('节点类型:', node.nodeType === 1 ? 'ELEMENT' : 'TEXT');
    if (node.nodeType === 1) {
      console.log('标签:', node.tagName);
      console.log('class:', node.className);
    }
    
    let parent = node.nodeType === 3 ? node.parentElement : node;
    console.log('\n祖先链:');
    let level = 0;
    while (parent && level < 10) {
      console.log(`${'  '.repeat(level)}<${parent.tagName.toLowerCase()} class="${parent.className}" id="${parent.id}">`);
      parent = parent.parentElement;
      level++;
    }
  });
}
