export interface Glossary {
  document_terms: string[];
}

export interface TranslationService {
  translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary: Glossary,
    context?: string
  ): Promise<string>;

  translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary: Glossary,
    context?: string
  ): AsyncGenerator<string, string, unknown>;
}
