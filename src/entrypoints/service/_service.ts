export interface TranslationResult {
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
}

export interface TranslationService {
  translate(
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<TranslationResult>;
}
