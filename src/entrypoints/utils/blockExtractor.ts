export interface TextBlock {
  id: string;
  xpath: string;
  tag: string;
  text: string;
  context?: {
    headingPath: string[];
    position: number;
  };
}

const PROCESSABLE_TAGS = new Set([
  'P',
  'LI',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'TD',
  'TH',
  'CAPTION',
  'FIGCAPTION',
  'LABEL',
  'LEGEND',
  'SUMMARY',
  'DT',
  'DD',
  'SPAN',
  'DIV',
  'SECTION',
  'ARTICLE',
  'MAIN',
]);

const IGNORE_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'CODE',
  'PRE',
  'SVG',
  'BUTTON',
  'NAV',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'IFRAME',
  'VIDEO',
  'AUDIO',
  'CANVAS',
  'FORM',
  'HEADER',
  'FOOTER',
  'MENU',
  'DIALOG',
  'DETAILS',
  'SUMMARY',
]);

function getXPath(node: Node): string {
  if (node.nodeType === Node.DOCUMENT_NODE) return '';
  if (!(node instanceof Element)) return '';

  const parts: string[] = [];
  let current: Element | null = node;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let sibling = current.previousElementSibling;

    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }

    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = current.parentElement;
  }

  return '/' + parts.join('/');
}

function getHeadingPath(block: Element): string[] {
  const headings: string[] = [];
  let current: Element | null = block;

  while (current) {
    const prevHeading = findPreviousHeading(current);
    if (prevHeading) {
      headings.unshift(prevHeading.textContent?.trim() || '');
      current = prevHeading;
    } else {
      break;
    }
  }

  return headings;
}

function findPreviousHeading(element: Element): Element | null {
  let current: Node | null = element;

  while (current) {
    while (current.previousSibling) {
      current = current.previousSibling;
      if (current.nodeType === Node.ELEMENT_NODE) {
        const el = current as Element;
        if (/^H[1-6]$/.test(el.tagName)) return el;
        const found = findLastHeading(el);
        if (found) return found;
      }
    }
    current = current.parentElement;
  }

  return null;
}

function findLastHeading(element: Element): Element | null {
  const children = Array.from(element.children).reverse();
  for (const child of children) {
    if (/^H[1-6]$/.test(child.tagName)) return child;
    const found = findLastHeading(child);
    if (found) return found;
  }
  return null;
}

export function extractBlocks(root: Document | Element): TextBlock[] {
  const blocks: TextBlock[] = [];
  let blockId = 0;

  const GENERIC_TAGS = new Set(['DIV', 'SPAN', 'SECTION', 'ARTICLE', 'MAIN']);

  function hasProcessableChild(element: Element): boolean {
    for (const child of Array.from(element.children)) {
      if (PROCESSABLE_TAGS.has(child.tagName) && !IGNORE_TAGS.has(child.tagName)) {
        return true;
      }
      if (hasProcessableChild(child)) return true;
    }
    return false;
  }

  function traverse(node: Node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node as Element;

    if (IGNORE_TAGS.has(element.tagName)) return;

    if (PROCESSABLE_TAGS.has(element.tagName)) {
      const text = element.textContent?.trim();
      const isGeneric = GENERIC_TAGS.has(element.tagName);
      const minTextLength = isGeneric ? 50 : 0;

      if (
        text &&
        text.length > minTextLength &&
        (!isGeneric || !hasProcessableChild(element))
      ) {
        const id = `b${++blockId}`;
        blocks.push({
          id,
          xpath: getXPath(element),
          tag: element.tagName.toLowerCase(),
          text,
          context: {
            headingPath: getHeadingPath(element),
            position: blockId,
          },
        });
        return;
      }
    }

    for (const child of Array.from(element.children)) {
      traverse(child);
    }
  }

  traverse(root);
  return blocks;
}

export function findBlockNode(block: TextBlock, root: Document): Node | null {
  try {
    const result = root.evaluate(
      block.xpath,
      root,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return result.singleNodeValue;
  } catch {
    return null;
  }
}

export function buildNodeMap(
  blocks: TextBlock[],
  root: Document
): Map<string, Node> {
  const map = new Map<string, Node>();

  for (const block of blocks) {
    const node = findBlockNode(block, root);
    if (node) {
      map.set(block.id, node);
    }
  }

  return map;
}
