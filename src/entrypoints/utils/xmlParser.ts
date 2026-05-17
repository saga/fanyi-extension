import { XMLParser } from 'fast-xml-parser';

export interface ParsedTranslationBlock {
  id: string;
  translatedText: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: true,
  trimValues: true,
});

export function parseTranslationXml(xmlString: string): ParsedTranslationBlock[] {
  const cleanedXml = cleanXmlString(xmlString);

  try {
    const result = parser.parse(cleanedXml);

    if (!result.DOC || !result.DOC.BLOCK) {
      throw new Error('Invalid XML structure: missing DOC or BLOCK elements');
    }

    const blocks = Array.isArray(result.DOC.BLOCK)
      ? result.DOC.BLOCK
      : [result.DOC.BLOCK];

    return blocks
      .filter((block: any) => block['@_id'] && block['#text'])
      .map((block: any) => ({
        id: block['@_id'],
        translatedText: block['#text'],
      }));
  } catch (error) {
    console.error('Failed to parse translation XML:', error);
    throw new Error(`XML parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

function cleanXmlString(xmlString: string): string {
  let cleaned = xmlString.trim();

  if (cleaned.startsWith('```xml')) {
    cleaned = cleaned.replace(/^```xml\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  return cleaned.trim();
}

export function validateXmlStructure(xmlString: string): boolean {
  try {
    const cleaned = cleanXmlString(xmlString);
    if (!cleaned.includes('<DOC>') || !cleaned.includes('</DOC>')) {
      return false;
    }
    if (!cleaned.includes('<BLOCK') || !cleaned.includes('</BLOCK>')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
