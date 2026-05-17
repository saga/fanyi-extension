import { MicrosoftTranslationService } from '../service/microsoft';
import { GoogleTranslationService } from '../service/google';
import { DeepLTranslationService } from '../service/deepl';
import type { TranslationResult } from '../service/_service';
import { getConfig } from './config';

const cache = new Map<string, TranslationResult>();

export async function translateText(
  text: string,
  targetLang?: string
): Promise<TranslationResult> {
  const config = await getConfig();
  const cacheKey = `${text}_${config.sourceLang}_${targetLang || config.targetLang}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  let service;
  switch (config.engine) {
    case 'microsoft':
      service = new MicrosoftTranslationService();
      break;
    case 'google':
      service = new GoogleTranslationService();
      break;
    case 'deepl':
      service = new DeepLTranslationService(config.deeplApiKey || '');
      break;
    default:
      service = new MicrosoftTranslationService();
  }

  const result = await service.translate(
    text,
    config.sourceLang,
    targetLang || config.targetLang
  );

  cache.set(cacheKey, result);
  return result;
}

export function clearCache(): void {
  cache.clear();
}
