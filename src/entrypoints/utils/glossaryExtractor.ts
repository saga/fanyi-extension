import nlp from 'compromise/two';
import type { GlossaryEntry } from '../service/_service';

const COMMON_ENGLISH_WORDS = new Set([
  'THE', 'AND', 'FOR', 'NOT', 'ARE', 'BUT', 'ALL', 'CAN', 'HAS', 'HER',
  'WAS', 'ONE', 'OUR', 'OUT', 'USE', 'VIA', 'WHO', 'ITS', 'MAY', 'NOR',
  'SINCE', 'INTO', 'FROM', 'THIS', 'THAT', 'WITH', 'SUCH', 'EACH', 'WHEN',
  'WHERE', 'WHICH', 'WHILE', 'OVER', 'BOTH', 'THEN', 'THAN', 'THEY', 'THEM',
  'THEIR', 'THESE', 'THOSE', 'BEEN', 'BEING', 'HAVE', 'WILL', 'WOULD',
  'COULD', 'SHOULD', 'ABOUT', 'OTHER', 'ALSO', 'SOME', 'VERY', 'JUST',
  'MORE', 'MOST', 'ONLY', 'SAME', 'HOW', 'ANY', 'FEW', 'MANY', 'MUCH',
  'NOW', 'NEW', 'OLD', 'FIRST', 'LAST', 'LONG', 'GREAT', 'LITTLE', 'OWN',
  'STILL', 'BACK', 'AFTER', 'BEFORE', 'UNDER', 'AGAIN', 'FURTHER', 'ONCE',
  'HERE', 'THERE', 'WHY', 'WHAT', 'NO', 'YES', 'OR', 'IF', 'SO', 'AS',
  'AT', 'BY', 'TO', 'UP', 'DO', 'AN', 'IN', 'ON', 'IT', 'IS', 'OF', 'WE',
  'HE', 'MY', 'ME', 'US', 'AM', 'BE', 'GO', 'HIGH', 'LES', 'PA', 'ISBN',
  'ISBN', 'HTML', 'JSON', 'ACM', 'PA', 'MAE', 'BETA', 'MATH',
]);

const ACRONYM_PATTERN = /\b[A-Z]{2,6}\b/g;

function extractAcronyms(text: string): string[] {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = ACRONYM_PATTERN.exec(text)) !== null) {
    const word = match[0];
    if (!COMMON_ENGLISH_WORDS.has(word)) {
      found.add(word);
    }
  }
  return [...found];
}

function extractNamedEntities(text: string): string[] {
  const doc = nlp(text);
  const entities = new Set<string>();

  for (const person of doc.match('#Person+').out('array')) {
    if (person.length > 2 && person.length < 60) {
      entities.add(person);
    }
  }

  for (const org of doc.match('#Organization+').out('array')) {
    if (org.length > 2 && org.length < 60) {
      entities.add(org);
    }
  }

  for (const place of doc.match('#Place+').out('array')) {
    if (place.length > 2 && place.length < 60) {
      entities.add(place);
    }
  }

  return [...entities];
}

function isSubsumedByLonger(term: string, allTerms: string[]): boolean {
  for (const other of allTerms) {
    if (other !== term && other.includes(term) && other.length > term.length) {
      return true;
    }
  }
  return false;
}

export function extractGlossaryLocal(
  fullText: string,
  emphasizedTerms: string[] = []
): GlossaryEntry[] {
  const glossaryMap = new Map<string, string>();

  const acronyms = extractAcronyms(fullText);
  for (const acronym of acronyms) {
    glossaryMap.set(acronym, 'KEEP');
  }

  const namedEntities = extractNamedEntities(fullText);
  for (const entity of namedEntities) {
    glossaryMap.set(entity, 'KEEP');
  }

  for (const term of emphasizedTerms) {
    const trimmed = term.trim();
    if (trimmed.length > 1 && trimmed.length < 80) {
      glossaryMap.set(trimmed, 'KEEP');
    }
  }

  const allTerms = [...glossaryMap.keys()];
  const filtered = allTerms.filter(term => !isSubsumedByLonger(term, allTerms));

  const result: GlossaryEntry[] = [];
  for (const term of filtered) {
    result.push({ term, translation: glossaryMap.get(term)! });
  }

  result.sort((a, b) => b.term.length - a.term.length);

  return result;
}
