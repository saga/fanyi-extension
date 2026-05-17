import type { TranslationResult, TranslationService } from './_service';

export class MicrosoftTranslationService implements TranslationService {
  async translate(
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<TranslationResult> {
    const url = `https://api-edge.translate.microsoft.com/translate?text=${encodeURIComponent(
      text
    )}&from=${sourceLang}&to=${targetLang}&api-version=3.0`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Microsoft Translation API error: ${response.status}`);
    }

    const data = await response.json();
    const translatedText = data[0]?.translations[0]?.text || '';

    return {
      sourceText: text,
      translatedText,
      sourceLang: data[0]?.detectedLanguage?.language || sourceLang,
      targetLang,
    };
  }
}
