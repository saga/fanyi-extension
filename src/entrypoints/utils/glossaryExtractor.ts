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
  'HTML', 'JSON', 'ACM', 'PA', 'MAE', 'BETA', 'MATH',
  'MUST', 'DOER', 'VS', 'GET', 'SET', 'PUT', 'LET', 'SEE', 'SAY', 'DAY',
  'WAY', 'OWN', 'TOO', 'ANY', 'TRY', 'USE', 'RUN', 'ADD', 'END', 'TOP',
  'BIG', 'BAD', 'RED', 'MAN', 'OLD', 'NEW', 'HOT', 'FAR', 'OFF', 'LOT',
  'AGE', 'AGO', 'DUE', 'YET', 'NON', 'PER', 'SUB', 'PRE', 'PRO', 'POST',
  'SELF', 'TRUE', 'NULL', 'VOID', 'TYPE', 'LIKE', 'EVEN', 'WELL', 'BACK',
  'NEXT', 'LAST', 'BEST', 'DONE', 'MADE', 'GONE', 'TOLD', 'CAME', 'WENT',
  'TOOK', 'MADE', 'SAID', 'KNEW', 'GOT', 'NEED', 'MAKE', 'HELP', 'WORK',
  'PART', 'GOOD', 'LOOK', 'COME', 'THAN', 'OVER', 'CALL', 'KEEP', 'GIVE',
  'TURN', 'MOVE', 'LIVE', 'SHOW', 'FIND', 'HAND', 'HEAD', 'SIDE', 'LINE',
  'CASE', 'POINT', 'MEAN', 'USED', 'SEEM', 'WANT', 'FACT', 'FORM', 'SURE',
  'ABLE', 'JUST', 'ALSO', 'ABLE', 'ELSE', 'EVER', 'SUCH', 'STILL', 'SINCE',
]);

const ACRONYM_PATTERN = /\b[A-Z]{2,6}\b/g;

function cleanTerm(term: string): string {
  return term.replace(/[,;:.!?'"()\[\]{}]+$/, '').replace(/^[,;:.!?'"()\[\]{}]+/, '').trim();
}

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
    const cleaned = cleanTerm(person);
    if (cleaned.length > 2 && cleaned.length < 60) {
      entities.add(cleaned);
    }
  }

  for (const org of doc.match('#Organization+').out('array')) {
    const cleaned = cleanTerm(org);
    if (cleaned.length > 2 && cleaned.length < 60) {
      entities.add(cleaned);
    }
  }

  for (const place of doc.match('#Place+').out('array')) {
    const cleaned = cleanTerm(place);
    if (cleaned.length > 2 && cleaned.length < 60) {
      entities.add(cleaned);
    }
  }

  return [...entities];
}

const CAMEL_CASE_PATTERN = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;

const COMMON_CAPITALIZED_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'Then', 'Than', 'They', 'Them',
  'Their', 'There', 'When', 'Where', 'Which', 'While', 'What', 'Who',
  'How', 'Why', 'Will', 'Would', 'Could', 'Should', 'Must', 'Have',
  'Has', 'Had', 'Been', 'Being', 'Does', 'Did', 'Was', 'Were',
  'And', 'But', 'For', 'Not', 'Nor', 'Yet', 'So', 'Or', 'If',
  'From', 'Into', 'With', 'Over', 'Under', 'After', 'Before', 'Between',
  'Through', 'During', 'Without', 'Within', 'Along', 'Across',
  'Each', 'Every', 'Both', 'All', 'Some', 'Any', 'Many', 'Much',
  'More', 'Most', 'Such', 'Other', 'Another', 'Only', 'Just',
  'Also', 'Even', 'Still', 'Already', 'Never', 'Always',
  'You', 'We', 'He', 'She', 'It', 'They', 'Who', 'What',
  'Code', 'Prompt', 'Work', 'Team', 'File', 'Data', 'Time',
  'Make', 'Keep', 'Give', 'Take', 'Come', 'Go', 'Get',
  'One', 'Two', 'Three', 'Four', 'Five', 'First', 'Second',
  'New', 'Old', 'Good', 'Bad', 'Great', 'Small', 'Large',
  'Here', 'Now', 'Today', 'Next', 'Last', 'Back',
]);

function extractRecurringProperNouns(text: string): string[] {
  const lowerWords = new Set<string>();
  const lowerMatch = text.match(/\b[a-z]+\b/g);
  if (lowerMatch) {
    for (const w of lowerMatch) {
      lowerWords.add(w.toLowerCase());
    }
  }

  const candidates = new Map<string, number>();
  let match: RegExpExecArray | null;
  while ((match = CAMEL_CASE_PATTERN.exec(text)) !== null) {
    const word = match[0];
    candidates.set(word, (candidates.get(word) || 0) + 1);
  }

  const SINGLE_WORD_CAP = /\b[A-Z][a-z]{2,}\b/g;
  const wordCounts = new Map<string, number>();
  while ((match = SINGLE_WORD_CAP.exec(text)) !== null) {
    const word = match[0];
    if (!COMMON_CAPITALIZED_WORDS.has(word) && !lowerWords.has(word.toLowerCase())) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
  }

  const result: string[] = [];
  for (const [word, count] of candidates) {
    if (count >= 2) {
      result.push(word);
    }
  }
  for (const [word, count] of wordCounts) {
    if (count >= 3) {
      result.push(word);
    }
  }

  return result;
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

  const recurringNouns = extractRecurringProperNouns(fullText);
  for (const noun of recurringNouns) {
    if (!glossaryMap.has(noun)) {
      glossaryMap.set(noun, 'KEEP');
    }
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
