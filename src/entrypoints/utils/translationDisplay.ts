export type TranslationMode = 'bilingual';

/**
 * Wrap translation around an element without destroying its existing children.
 *
 * Why this matters: the previous implementation used `node.textContent = ''`
 * or `node.textContent = translatedText`, which destroyed any nested links,
 * images, inline formatting, etc. — making the original content unclickable.
 *
 * Now we move the existing child nodes into a `.fanyi-original` span, and
 * append a `.fanyi-translation` span alongside. The original DOM tree is
 * preserved untouched and can be restored by moving the children back in
 * `restoreBlock`.
 *
 * 始终使用双语对照模式 (original + translation 并排显示)。
 */
export function applyBlockTranslation(
  node: HTMLElement,
  translatedText: string,
): void {
  if (node.classList.contains('fanyi-translated')) {
    return;
  }

  const originalText = node.textContent || '';
  node.classList.add('fanyi-translated');
  node.dataset.originalText = originalText;

  // Move existing children into .fanyi-original so they survive translation.
  const originalSpan = document.createElement('span');
  originalSpan.className = 'fanyi-original';
  while (node.firstChild) {
    originalSpan.appendChild(node.firstChild);
  }

  const translationSpan = document.createElement('span');
  translationSpan.className = 'fanyi-translation';
  translationSpan.textContent = translatedText;

  node.appendChild(originalSpan);
  node.appendChild(translationSpan);
}

export function restoreBlock(node: HTMLElement): void {
  const originalText = node.dataset.originalText;
  const originalSpan = node.querySelector('.fanyi-original');
  if (originalSpan) {
    // Move original children back to the parent so links/formatting work again.
    while (originalSpan.firstChild) {
      node.insertBefore(originalSpan.firstChild, originalSpan);
    }
    originalSpan.remove();
  }
  const translationSpan = node.querySelector('.fanyi-translation');
  if (translationSpan) {
    translationSpan.remove();
  }
  if (originalText !== undefined && !node.textContent) {
    node.textContent = originalText;
  }
  node.classList.remove('fanyi-translated');
  node.classList.remove('fanyi-missing');
  node.removeAttribute('title');
  delete node.dataset.originalText;
}

export function toggleBlockTranslation(node: HTMLElement): void {
  const translationSpan = node.querySelector('.fanyi-translation');
  if (translationSpan) {
    const el = translationSpan as HTMLElement;
    el.style.display = el.style.display === 'none' ? '' : 'none';
  }
}

/**
 * 清理页面上所有翻译标记（.fanyi-original / .fanyi-translation / .fanyi-translated
 * / .fanyi-missing），但保留 walker 设置的 data-fanyi-block-id。
 *
 * 用途：服务端翻译前，先把当前 DOM 恢复到“未翻译但已标记 block id”的状态，
 * 避免把已有的译文/原文双语文本一起发给服务端。
 */
export function cleanupTranslationMarks(): void {
  for (const node of Array.from(document.querySelectorAll('.fanyi-translated'))) {
    const el = node as HTMLElement;
    const originalSpan = el.querySelector('.fanyi-original');
    if (originalSpan) {
      while (originalSpan.firstChild) {
        el.insertBefore(originalSpan.firstChild, originalSpan);
      }
      originalSpan.remove();
    }
    el.querySelector('.fanyi-translation')?.remove();
    el.classList.remove('fanyi-translated');
    delete el.dataset.originalText;
  }
  for (const node of Array.from(document.querySelectorAll('.fanyi-missing'))) {
    const el = node as HTMLElement;
    el.classList.remove('fanyi-missing');
    el.removeAttribute('title');
  }
}
