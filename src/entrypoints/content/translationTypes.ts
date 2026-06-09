/** 共享状态：在主流程中累积，restore 时用。 */
export interface TranslationState {
  originalTexts: Map<string, string>;
  translatedBlocks: Set<string>;
}
