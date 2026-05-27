export type TranslationMode = 'bilingual' | 'target';

export function applyBlockTranslation(
  node: HTMLElement,
  translatedText: string,
  mode: TranslationMode
): void {
  if (node.classList.contains('fanyi-translated')) {
    return;
  }

  const originalText = node.textContent || '';
  node.classList.add('fanyi-translated');
  node.dataset.originalText = originalText;

  if (mode === 'target') {
    node.textContent = translatedText;
  } else {
    const originalSpan = document.createElement('span');
    originalSpan.className = 'fanyi-original';
    originalSpan.textContent = originalText;

    const translationSpan = document.createElement('span');
    translationSpan.className = 'fanyi-translation';
    translationSpan.textContent = translatedText;

    node.textContent = '';
    node.appendChild(originalSpan);
    node.appendChild(translationSpan);
  }
}

export function restoreBlock(node: HTMLElement): void {
  const originalText = node.dataset.originalText;
  if (originalText !== undefined) {
    node.textContent = originalText;
  }
  node.classList.remove('fanyi-translated');
  delete node.dataset.originalText;
}

export function toggleBlockTranslation(node: HTMLElement): void {
  const translationSpan = node.querySelector('.fanyi-translation');
  if (translationSpan) {
    const el = translationSpan as HTMLElement;
    el.style.display = el.style.display === 'none' ? '' : 'none';
  }
}
