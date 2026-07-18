// 译文回传 — 扩展端本地翻译完成后,异步回传服务端
//
// 设计要点:
//   1. 仅在用户开启"共享译文"设置时回传(默认关闭,保护隐私)
//   2. 异步执行,不阻塞用户翻译流程
//   3. 失败静默(不弹错误提示,只打 console.warn)
//   4. 包含 contentHash 让服务端做去重和校验

import type { Config } from './config';

const UPLOAD_ENDPOINT = '/fanyi/page/upload';
const MAX_UPLOAD_SIZE = 900_000;  // 900KB,与服务端 MAX_FULL_HTML_CHARS 对齐
const UPLOAD_TIMEOUT_MS = 10_000;  // 10 秒超时

export interface UploadRequest {
  url: string;
  html: string;
  sourceLang: string;
  targetLang: string;
  provider: string;
  promptStyle: string;
  contentHash: string;  // 用于服务端去重和校验
}

export interface UploadResponse {
  accepted: boolean;
  reason?: string;
}

/**
 * 异步回传译文到服务端。
 * 只在用户开启"共享译文"且译文质量可靠时回传。
 *
 * @param config 用户配置(检查 shareTranslations 开关)
 * @param request 回传请求
 */
export async function uploadTranslation(
  config: Config & { shareTranslations?: boolean },
  request: UploadRequest,
): Promise<UploadResponse> {
  // 1. 隐私检查:用户必须显式开启
  if (!config.shareTranslations) {
    return { accepted: false, reason: '用户未开启共享译文' };
  }

  // 2. 大小检查
  if (request.html.length > MAX_UPLOAD_SIZE) {
    return { accepted: false, reason: `HTML 超过最大尺寸 ${MAX_UPLOAD_SIZE}` };
  }

  // 3. URL 隐私检查:不回传私有 URL
  if (isPrivateUrl(request.url)) {
    return { accepted: false, reason: '私有 URL 不回传' };
  }

  // 4. 构造服务端 URL
  const serverUrl = (config.serverUrl || '').replace(/\/fanyi\/page$/, UPLOAD_ENDPOINT);
  if (!serverUrl) {
    return { accepted: false, reason: '服务端 URL 未配置' };
  }

  // 5. 异步上传(带超时)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

    const response = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[uploader] 回传失败: ${response.status}`);
      return { accepted: false, reason: `服务端返回 ${response.status}` };
    }

    const result = await response.json() as UploadResponse;
    return result;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('[uploader] 回传超时');
    } else {
      console.warn('[uploader] 回传失败:', err);
    }
    return { accepted: false, reason: '网络错误' };
  }
}

/**
 * 检查是否为私有 URL(不应回传)。
 * 私有 URL 包括:localhost、内网 IP、file://、私有域名等。
 */
function isPrivateUrl(url: string): boolean {
  const privatePatterns = [
    /^https?:\/\/localhost/i,
    /^https?:\/\/127\./i,
    /^https?:\/\/192\.168\./i,
    /^https?:\/\/10\./i,
    /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./i,
    /^file:\/\//i,
    /^https?:\/\/[^/]*\.local\b/i,
  ];

  return privatePatterns.some(pattern => pattern.test(url));
}

/**
 * 批量回传(用于离线队列恢复后批量上传)。
 */
export async function uploadBatch(
  config: Config & { shareTranslations?: boolean },
  requests: UploadRequest[],
): Promise<UploadResponse[]> {
  const results: UploadResponse[] = [];
  for (const request of requests) {
    const result = await uploadTranslation(config, request);
    results.push(result);
  }
  return results;
}
