import type { TranslationResult, TranslationService } from './_service';

export class DeepLTranslationService implements TranslationService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async translate(
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<TranslationResult> {
    const url = 'https://api-free.deepl.com/v2/translate';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `DeepL-Auth-Key ${this.apiKey}`,
      },
      body: new URLSearchParams({
        text,
        source_lang: sourceLang === 'auto' ? 'EN' : sourceLang.toUpperCase(),
        target_lang: targetLang.toUpperCase(),
      }),
    });

    if (!response.ok) {
      throw new Error(`DeepL API error: ${response.status}`);
    }

    const data = await response.json();
    const translatedText = data.translations[0]?.text || '';

    return {
      sourceText: text,
      translatedText,
      sourceLang,
      targetLang,
    };
  }
}
