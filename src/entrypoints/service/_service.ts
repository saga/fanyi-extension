export interface GlossaryEntry {
  term: string;
  translation: string;
}

export interface TranslationService {
  translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary: GlossaryEntry[],
    context?: string
  ): Promise<string>;

  translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary: GlossaryEntry[],
    context?: string
  ): AsyncGenerator<string, string, unknown>;
}
