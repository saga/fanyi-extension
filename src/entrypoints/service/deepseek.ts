import type {
  TranslationService,
  DocumentAnalysis,
  GlossaryEntry,
} from './_service';

const API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';

const TRANSLATE_TOOL = {
  type: 'function',
  function: {
    name: 'translate_blocks',
    description: 'Translate text blocks and return the results as a JSON array',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        translations: {
          type: 'array',
          description: 'Array of translated blocks',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'The original block ID',
              },
              translated_text: {
                type: 'string',
                description: 'The translated text',
              },
            },
            required: ['id', 'translated_text'],
            additionalProperties: false,
          },
        },
      },
      required: ['translations'],
      additionalProperties: false,
    },
  },
};

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

  const blocksText = blocks
    .map((b) => `[${b.id}] ${b.text}`)
    .join('\n');

  return JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a professional translator. Translate the given text blocks to ${targetLang === 'zh' ? 'Simplified Chinese' : targetLang}.

Requirements:
- Keep all block IDs unchanged
- Keep terminology consistent
- Use natural ${targetLang === 'zh' ? 'Simplified Chinese' : targetLang}
- Do not omit content
- Do not summarize
- Use the translate_blocks tool to return results

Terminology Glossary:
${glossaryText}

${context ? `Document Context:\n${context}` : ''}`,
      },
      {
        role: 'user',
        content: `Translate these blocks:\n\n${blocksText}`,
      },
    ],
    tools: [TRANSLATE_TOOL],
    tool_choice: 'required',
    reasoning_effort: 'high',
    output_config: { effort: 'high' },
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

async function callApiWithTool(
  apiKey: string,
  body: string
): Promise<Array<{ id: string; translated_text: string }>> {
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
  const toolCalls = data.choices?.[0]?.message?.tool_calls;

  if (!toolCalls || toolCalls.length === 0) {
    throw new Error('No tool call returned from DeepSeek');
  }

  const toolArgs = JSON.parse(toolCalls[0].function.arguments);
  return toolArgs.translations || [];
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

    const translations = await callApiWithTool(this.apiKey, body);

    return JSON.stringify(translations);
  }
}
