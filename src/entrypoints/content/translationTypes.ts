/** 共享状态：在主流程中累积，restore 时用。 */
export interface TranslationState {
  originalTexts: Map<string, string>;
  translatedBlocks: Set<string>;
  /** blockId -> translatedText，用于 React/Next.js 重新渲染后恢复翻译。 */
  translatedTexts: Map<string, string>;
}
