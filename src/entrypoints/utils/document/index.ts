/**
 * 文档解析统一入口。
 *
 * 二进制格式（pdf / docx / epub）走**动态 import**，让 pdfjs-dist 与 jszip
 * 单独打 chunk —— 只有真正打开文档翻译页时才加载，不污染 popup / sidepanel 体积。
 */
import type { DocumentInput, ParsedDocument } from './types';
import { detectFormat, isWithinSizeLimit, MAX_DOCUMENT_BYTES } from './detect';

// 注意：这里**不要** `export *` 各个 parser。
// barrel 静态导出 + 下面 parseDocument 里的动态 import 会让 Vite 报
// INEFFECTIVE_DYNAMIC_IMPORT 并把模块打回主 chunk（曾经的坑）。
// 需要单独用某个 parser 时直接按路径引，保持懒加载生效。
export * from './types';
export * from './detect';
export * from './batcher';
export * from './export';

export interface ParseDocumentOptions {
  maxSegmentChars?: number;
  maxPages?: number;
  onProgress?: (done: number, total: number) => void;
}

function decodeBuffer(buffer: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(buffer);
}

export class UnsupportedDocumentError extends Error {
  constructor(public readonly fileName: string) {
    super(`不支持的文件类型：${fileName}`);
    this.name = 'UnsupportedDocumentError';
  }
}

/**
 * 解析任意支持格式的文档。
 * 失败时抛出 Error（message 可直接展示给用户），而不是返回空结果 ——
 * 静默的空结果会让用户以为"翻译坏了"，明确的报错才能引导换格式。
 */
export async function parseDocument(
  input: DocumentInput,
  options: ParseDocumentOptions = {},
): Promise<ParsedDocument> {
  const format = detectFormat(input.fileName, input.mime);
  if (!format) throw new UnsupportedDocumentError(input.fileName);

  if (!isWithinSizeLimit(input)) {
    throw new Error(
      `文件超过 ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB 上限，请拆分后再试`,
    );
  }

  const getText = (): string => {
    if (input.text != null) return input.text;
    if (input.arrayBuffer) return decodeBuffer(input.arrayBuffer);
    throw new Error('文件内容为空');
  };

  const getBuffer = (): ArrayBuffer => {
    if (input.arrayBuffer) return input.arrayBuffer;
    if (input.text != null) return new TextEncoder().encode(input.text).buffer as ArrayBuffer;
    throw new Error('文件内容为空');
  };

  switch (format) {
    case 'txt':
    case 'md': {
      const { parseTextDocument } = await import('./parsers/text');
      return parseTextDocument(getText(), format, {
        maxSegmentChars: options.maxSegmentChars,
        fileName: input.fileName,
      });
    }
    case 'srt':
    case 'vtt': {
      const { parseSubtitleDocument } = await import('./parsers/subtitle');
      return parseSubtitleDocument(getText(), format, input.fileName);
    }
    case 'html': {
      const { parseHtmlDocument } = await import('./parsers/html');
      return parseHtmlDocument(getText(), {
        maxSegmentChars: options.maxSegmentChars,
        fileName: input.fileName,
      });
    }
    case 'json': {
      const { parseJsonDocument } = await import('./parsers/json');
      return parseJsonDocument(getText(), {
        maxSegmentChars: options.maxSegmentChars,
        fileName: input.fileName,
      });
    }
    case 'docx': {
      const { parseDocxDocument } = await import('./parsers/office');
      return parseDocxDocument(getBuffer(), {
        maxSegmentChars: options.maxSegmentChars,
        fileName: input.fileName,
      });
    }
    case 'epub': {
      const { parseEpubDocument } = await import('./parsers/office');
      return parseEpubDocument(getBuffer(), {
        maxSegmentChars: options.maxSegmentChars,
        fileName: input.fileName,
      });
    }
    case 'pdf': {
      const { parsePdfDocument } = await import('./parsers/pdf');
      return parsePdfDocument(getBuffer(), {
        maxSegmentChars: options.maxSegmentChars,
        maxPages: options.maxPages,
        fileName: input.fileName,
        onProgress: options.onProgress,
      });
    }
    default:
      throw new UnsupportedDocumentError(input.fileName);
  }
}
