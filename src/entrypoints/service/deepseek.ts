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

function buildBody(messages: Array<{ role: string; content: string }>) {
  return JSON.stringify({
    model: MODEL,
    messages,
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
    stream: false,
  });
}

async function callApi(apiKey: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: buildBody(messages),
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
    const prompt = `You are a professional translator and document analyst.

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
${text.substring(0, 8000)}`;

    const content = await callApi(this.apiKey, [{ role: 'user', content: prompt }]);
    return JSON.parse(content);
  }

  async translate(
    xmlContent: string,
    sourceLang: string,
    targetLang: string,
    glossary: GlossaryEntry[],
    context?: string
  ): Promise<string> {
    const glossaryText = glossary
      .map((g) => `${g.term} => ${g.translation}`)
      .join('\n');

    const prompt = `You are a professional translator.

Requirements:
- Preserve XML structure
- Preserve all BLOCK ids unchanged
- Keep terminology consistent
- Use natural ${targetLang === 'zh' ? 'Simplified Chinese' : targetLang}
- Do not omit content
- Do not summarize
- Return valid XML only

Terminology Glossary:
${glossaryText}

${context ? `Document Context:\n${context}\n` : ''}

Translate the following XML to ${targetLang === 'zh' ? 'Simplified Chinese' : targetLang}:

${xmlContent}`;

    return callApi(this.apiKey, [{ role: 'user', content: prompt }]);
  }
}
