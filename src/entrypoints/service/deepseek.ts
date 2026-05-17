import OpenAI from 'openai';
import type {
  TranslationService,
  DocumentAnalysis,
  GlossaryEntry,
} from './_service';

export class DeepSeekTranslationService implements TranslationService {
  private client: OpenAI;
  private model = 'deepseek-v4-flash';

  constructor(apiKey: string) {
    this.client = new OpenAI({
      baseURL: 'https://api.deepseek.com',
      apiKey,
      dangerouslyAllowBrowser: true,
    });
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

    const completion = await this.client.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: this.model,
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      stream: false,
    });

    const content = completion.choices[0]?.message?.content;

    if (!content) {
      throw new Error('No analysis result from DeepSeek');
    }

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

    const completion = await this.client.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: this.model,
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      stream: false,
    });

    const content = completion.choices[0]?.message?.content;

    if (!content) {
      throw new Error('No translation result from DeepSeek');
    }

    return content;
  }
}
