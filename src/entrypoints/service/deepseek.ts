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
  targetLang: string,
  sitePrompt?: string
) {
  const blocksJson = JSON.stringify(
    blocks.map((b) => ({ id: b.id, text: b.text })),
    null,
    2
  );

  let systemContent = `Professional translator. Translate blocks to ${targetLang === 'zh' ? 'Simplified Chinese' : targetLang}.

Rules:
- Keep IDs unchanged
- Consistent terminology
- Natural translation
- No omissions
- Return JSON only`;

  if (sitePrompt) {
    systemContent += `\n\nSite-specific rules:\n${sitePrompt}`;
  }

  return JSON.stringify({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content: systemContent,
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
  console.log('[DeepSeek] Calling API:', API_URL);
  console.log('[DeepSeek] Request body length:', body.length, 'bytes');
  console.log('[DeepSeek] API Key length:', apiKey.length);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body,
    });

    console.log('[DeepSeek] Response status:', response.status);
    console.log('[DeepSeek] Response headers:', Object.fromEntries(response.headers.entries()));

    const responseText = await response.text().catch(() => '');
    console.log('[DeepSeek] Response body:', responseText.substring(0, 500));

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      
      // Try to parse error JSON for more details
      try {
        const errorJson = JSON.parse(responseText);
        if (errorJson.error) {
          errorMessage += ` - ${errorJson.error.message || errorJson.error}`;
          if (errorJson.error.type) errorMessage += ` [${errorJson.error.type}]`;
          if (errorJson.error.code) errorMessage += ` (code: ${errorJson.error.code})`;
        } else if (errorJson.message) {
          errorMessage += ` - ${errorJson.message}`;
        } else {
          errorMessage += ` - ${responseText.substring(0, 200)}`;
        }
      } catch {
        errorMessage += ` - ${responseText.substring(0, 200)}`;
      }

      // Add common error code explanations
      if (response.status === 401) {
        errorMessage += '\n\n可能原因: API Key 无效或已过期';
      } else if (response.status === 403) {
        errorMessage += '\n\n可能原因: 账户余额不足或被封禁';
      } else if (response.status === 429) {
        errorMessage += '\n\n可能原因: 请求频率超限，请稍后重试';
      } else if (response.status === 500 || response.status === 503) {
        errorMessage += '\n\n可能原因: DeepSeek 服务暂时不可用';
      }

      throw new Error(`DeepSeek API error: ${errorMessage}`);
    }

    const data = JSON.parse(responseText);
    console.log('[DeepSeek] Parsed response:', JSON.stringify(data).substring(0, 300));

    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error('[DeepSeek] Invalid response structure:', JSON.stringify(data).substring(0, 500));
      throw new Error('DeepSeek 返回了无效响应: 缺少 choices[0].message.content');
    }

    console.log('[DeepSeek] Response content length:', content.length);
    return content;
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      console.error('[DeepSeek] Fetch error - possible network/CORS issue:', error);
      throw new Error(`网络请求失败: ${error.message}\n\n可能原因:\n1. 网络连接问题\n2. Firefox 扩展权限不足\n3. 被防火墙/代理拦截`);
    }
    throw error;
  }
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
    context?: string,
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);

    const body = buildTranslationBody(
      blocks,
      sourceLang,
      targetLang,
      context
    );

    return await callApi(this.apiKey, body);
  }
}
