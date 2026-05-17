export interface TranslationResult {
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
}

export interface GlossaryEntry {
  term: string;
  translation: string;
}

export interface DocumentAnalysis {
  domain: string;
  tone: string;
  glossary: GlossaryEntry[];
  summary: string;
}

export interface TranslationService {
  analyzeDocument(
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<DocumentAnalysis>;

  translate(
    xmlContent: string,
    sourceLang: string,
    targetLang: string,
    glossary: GlossaryEntry[],
    context?: string
  ): Promise<string>;
}
