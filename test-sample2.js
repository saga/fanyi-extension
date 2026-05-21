
// 测试 sample2.html 的块提取
const fs = require('fs');
const { JSDOM } = require('jsdom');

// 读取 html 文件
const html = fs.readFileSync('/Users/saga/code-repos/fanyi-extension/sample2.html', 'utf8');

// 创建 DOM
const dom = new JSDOM(html);
const { document } = dom.window;

// 简单模拟 extractBlocks 的行为，打印关键信息
console.log('=== 开始分析 sample2.html 结构 ===\n');

// 找标题 "From Gemma 4 to DeepSeek V4..."
let targetElements = [];
function findTextInElements(root, searchText) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node;
  while (node = walker.nextNode()) {
    if (node.textContent && node.textContent.includes(searchText)) {
      targetElements.push(node);
    }
  }
}

// 查找目标文本
findTextInElements(document.body, 'From Gemma 4 to DeepSeek V4');
findTextInElements(document.body, 'After a short family break, I am excited to be back');

console.log(`找到 ${targetElements.length} 个包含目标文本的元素:\n`);

targetElements.forEach((el, idx) => {
  console.log(`--- 元素 ${idx + 1} ---`);
  console.log('标签名:', el.tagName);
  console.log('class:', el.className);
  console.log('完整文本:', el.textContent?.substring(0, 200));
  
  // 打印祖先链
  let current = el;
  let ancestors = [];
  while (current) {
    ancestors.push({
      tag: current.tagName,
      class: current.className,
      id: current.id
    });
    current = current.parentElement;
  }
  console.log('祖先链:', ancestors.map(a => `${a.tag}#${a.id || ''}.${a.class || ''}`).join(' > '));
  console.log('');
});
