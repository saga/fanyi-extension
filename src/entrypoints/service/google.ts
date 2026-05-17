import type { TranslationResult, TranslationService } from './_service';

export class GoogleTranslationService implements TranslationService {
  async translate(
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<TranslationResult> {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(
      text
    )}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Google Translation API error: ${response.status}`);
    }

    const data = await response.json();
    const translatedText = data[0]
      .map((item: any) => item[0])
      .filter(Boolean)
      .join('');

    return {
      sourceText: text,
      translatedText,
      sourceLang: sourceLang,
      targetLang,
    };
  }
}
