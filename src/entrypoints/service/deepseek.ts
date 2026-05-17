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

function buildAnalysisBody(
  text: string,
  sourceLang: string,
  targetLang: string
) {
  return JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: `You are a professional translator and document analyst.

Analyze the following document and extract:
1. Domain/field of the document
2. Tone/style
3. Key technical terms with their preferred translations
4. A brief summary

Source Language: ${sourceLang}
Target Language: ${targetLang}

Return ONLY a valid JSON object with this structure:
{
  "domain": "string",
  "tone": "string",
  "glossary": [{"term": "string", "translation": "string"}],
  "summary": "string"
}

Document:
${text.substring(0, 8000)}`,
      },
    ],
    response_format: { type: 'json_object' },
    reasoning_effort: 'high',
    output_config: { effort: 'high' },
    stream: false,
  });
}

function buildTranslationBody(
  blocks: Array<{ id: string; text: string }>,
  sourceLang: string,
  targetLang: string,
  glossary: GlossaryEntry[],
  context?: string
) {
  const glossaryText = glossary
    .map((g) => `${g.term} => ${g.translation}`)
    .join('\n');

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
- Return JSON only

Glossary: ${glossaryText}
${context ? `Context: ${context}` : ''}`,
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
    text: string,
    sourceLang: string,
    targetLang: string
  ): Promise<DocumentAnalysis> {
    const body = buildAnalysisBody(text, sourceLang, targetLang);
    const content = await callApi(this.apiKey, body);
    return JSON.parse(content);
  }

  async translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary: GlossaryEntry[],
    context?: string
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);

    const body = buildTranslationBody(
      blocks,
      sourceLang,
      targetLang,
      glossary,
      context
    );

    return await callApi(this.apiKey, body);
  }
}
