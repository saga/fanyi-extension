import type {
  TranslationService,
  DocumentAnalysis,
  GlossaryEntry,
} from './_service';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function buildTranslationBody(
  blocks: Array<{ id: string; text: string }>,
  sourceLang: string,
  targetLang: string
) {
  const blocksJson = JSON.stringify(
    blocks.map((b) => ({ id: b.id, text: b.text })),
    null,
    2
  );

  return JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `Professional translator. Translate blocks to ${targetLang === 'zh' ? 'Simplified Chinese' : targetLang}.

Rules:
- Keep IDs unchanged
- Consistent terminology
- Natural translation
- No omissions
- Return JSON only`,
      },
      {
        role: 'user',
        content: `Translate and return {"translations":[{"id":"b1","translated_text":"译文1"}]}:\n\n${blocksJson}`,
      },
    ],
    response_format: { type: 'json_object' },
    reasoning_effort: 'low',
    stream: false,
  });
}

async function callApi(
  apiKey: string,
  body: string
): Promise<string> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`DeepSeek API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('No response from DeepSeek');
  }

  return content;
}

export class DeepSeekTranslationService implements TranslationService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async analyzeDocument(
    _text: string,
    _sourceLang: string,
    _targetLang: string
  ): Promise<DocumentAnalysis> {
    return {
      domain: '',
      tone: '',
      glossary: [],
      summary: '',
    };
  }

  async translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    _glossary: GlossaryEntry[],
    _context?: string
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);

    const body = buildTranslationBody(
      blocks,
      sourceLang,
      targetLang
    );

    return await callApi(this.apiKey, body);
  }
}
