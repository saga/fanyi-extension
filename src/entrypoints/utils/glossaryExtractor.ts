import nlp from 'compromise/two';
import type { GlossaryEntry } from '../service/_service';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'not', 'nor', 'yet', 'so',
  'for', 'in', 'on', 'at', 'to', 'of', 'by', 'with', 'from', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'shall', 'may', 'might',
  'must', 'can', 'need', 'dare', 'ought', 'used',
  'it', 'its', 'he', 'him', 'his', 'she', 'her', 'we', 'us', 'our',
  'they', 'them', 'their', 'you', 'your', 'my', 'me', 'mine', 'yours',
  'this', 'that', 'these', 'those', 'who', 'whom', 'whose', 'which', 'what',
  'where', 'when', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'some', 'any', 'no', 'none', 'much', 'many',
  'other', 'another', 'such', 'same', 'own', 'than', 'then', 'too', 'very',
  'also', 'just', 'only', 'even', 'still', 'already', 'never', 'always',
  'here', 'there', 'now', 'well', 'about', 'above', 'below', 'under', 'over',
  'after', 'before', 'between', 'through', 'during', 'without', 'within',
  'along', 'across', 'against', 'into', 'onto', 'upon', 'out', 'off', 'up', 'down',
  'if', 'while', 'although', 'though', 'because', 'since', 'until', 'unless',
  'whether', 'rather', 'instead', 'however', 'therefore', 'thus', 'hence',
  'else', 'ever', 'once', 'again', 'further', 'back',
  'i', 'am', 'been', 'get', 'got', 'let', 'make', 'go', 'come', 'take',
  'give', 'see', 'know', 'think', 'say', 'tell', 'ask', 'use', 'find',
  'want', 'look', 'try', 'help', 'show', 'hear', 'play', 'run', 'move', 'live',
  'put', 'set', 'add', 'keep', 'start', 'stop', 'end', 'turn', 'call',
  'work', 'seem', 'feel', 'leave', 'bring', 'begin', 'show',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'first', 'second', 'third', 'last', 'next', 'new', 'old', 'good', 'bad',
  'great', 'small', 'large', 'big', 'long', 'short', 'high', 'low',
  'right', 'left', 'early', 'late', 'hard', 'easy', 'best', 'worst',
  'true', 'false', 'real', 'sure', 'able', 'free', 'full', 'empty',
  'different', 'important', 'possible', 'public', 'private', 'certain',
  'general', 'local', 'social', 'national', 'natural', 'political',
  'point', 'way', 'day', 'time', 'year', 'people', 'man', 'woman',
  'child', 'world', 'life', 'hand', 'part', 'place', 'case', 'week',
  'company', 'system', 'program', 'question', 'home', 'water', 'room',
  'area', 'money', 'story', 'fact', 'month', 'lot', 'right', 'study',
  'book', 'eye', 'job', 'word', 'business', 'issue', 'side', 'kind',
  'head', 'house', 'service', 'friend', 'father', 'mother', 'power',
  'hour', 'game', 'line', 'end', 'member', 'law', 'car', 'city',
  'community', 'name', 'president', 'team', 'minute', 'idea', 'body',
  'information', 'back', 'parent', 'face', 'level', 'office', 'door',
  'health', 'person', 'art', 'war', 'history', 'party', 'result',
  'morning', 'reason', 'research', 'girl', 'guy', 'moment', 'air',
  'teacher', 'force', 'education', 'foot', 'boy', 'age', 'policy',
  'music', 'market', 'sense', 'thing', 'things', 'love', 'class', 'state',
  'don', 'doesn', 'didn', 'won', 'wasn', 'weren', 'isn', 'aren',
  'hasn', 'haven', 'hadn', 'wouldn', 'couldn', 'shouldn', 'mustn',
  've', 'll', 're', 'won', 'shan',
]);

const ACRONYM_EXCLUSIONS = new Set([
  'THE', 'AND', 'FOR', 'NOT', 'ARE', 'BUT', 'ALL', 'CAN', 'HAS', 'HER',
  'WAS', 'ONE', 'OUR', 'OUT', 'USE', 'VIA', 'WHO', 'ITS', 'MAY', 'NOR',
  'SINCE', 'INTO', 'FROM', 'THIS', 'THAT', 'WITH', 'SUCH', 'EACH', 'WHEN',
  'WHERE', 'WHICH', 'WHILE', 'OVER', 'BOTH', 'THEN', 'THAN', 'THEY', 'THEM',
  'THEIR', 'THESE', 'THOSE', 'BEEN', 'BEING', 'HAVE', 'WILL', 'WOULD',
  'COULD', 'SHOULD', 'ABOUT', 'OTHER', 'ALSO', 'SOME', 'VERY', 'JUST',
  'MUST', 'DOER', 'VS', 'GET', 'SET', 'PUT', 'LET', 'SEE', 'SAY', 'DAY',
  'WAY', 'OWN', 'TOO', 'ANY', 'TRY', 'RUN', 'ADD', 'END', 'TOP',
  'BIG', 'BAD', 'RED', 'MAN', 'OLD', 'NEW', 'HOT', 'FAR', 'OFF', 'LOT',
  'AGE', 'AGO', 'DUE', 'YET', 'NON', 'PER', 'SUB', 'PRE', 'PRO', 'POST',
  'SELF', 'TRUE', 'NULL', 'VOID', 'TYPE', 'LIKE', 'EVEN', 'WELL', 'BACK',
  'NEXT', 'LAST', 'BEST', 'DONE', 'MADE', 'GONE', 'TOLD', 'CAME', 'WENT',
  'TOOK', 'SAID', 'KNEW', 'GOT', 'NEED', 'MAKE', 'HELP', 'WORK',
  'PART', 'GOOD', 'LOOK', 'COME', 'OVER', 'CALL', 'KEEP', 'GIVE',
  'TURN', 'MOVE', 'LIVE', 'SHOW', 'FIND', 'HAND', 'HEAD', 'SIDE', 'LINE',
  'CASE', 'POINT', 'MEAN', 'USED', 'SEEM', 'WANT', 'FACT', 'FORM', 'SURE',
  'ABLE', 'ELSE', 'EVER', 'STILL',
  'ISBN', 'HTML', 'JSON', 'ACM', 'BETA', 'MATH',
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
    if (!ACRONYM_EXCLUSIONS.has(word)) {
      found.add(word);
    }
  }
  return [...found];
}

function extractNamedEntities(doc: ReturnType<typeof nlp>): string[] {
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

function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase());
}

function hasSubstantiveWord(words: string[]): boolean {
  return words.some(w => !isStopword(w));
}

function extractFrequentTerms(doc: ReturnType<typeof nlp>): string[] {
  const phraseCounts = new Map<string, number>();
  const phraseOriginals = new Map<string, string>();

  const patterns = ['#Noun+', '#Noun #Gerund', '#Noun #Noun #Gerund'];
  for (const pattern of patterns) {
    for (const phrase of doc.match(pattern).out('array')) {
      const cleaned = cleanTerm(phrase);
      if (cleaned.length < 3 || cleaned.length > 60) continue;

      const words = cleaned.split(/\s+/);
      if (!hasSubstantiveWord(words)) continue;
      if (isStopword(words[0])) continue;

      const key = cleaned.toLowerCase();
      phraseCounts.set(key, (phraseCounts.get(key) || 0) + 1);
      if (!phraseOriginals.has(key)) {
        phraseOriginals.set(key, cleaned);
      }
    }
  }

  const merged = new Map<string, number>();
  const mergedOriginals = new Map<string, string>();
  const processed = new Set<string>();

  for (const [key, count] of phraseCounts.entries()) {
    if (processed.has(key)) continue;

    let totalCount = count;
    const singular = key.replace(/s$/, '');
    if (singular !== key && phraseCounts.has(singular)) {
      totalCount += phraseCounts.get(singular)!;
      processed.add(singular);
    }

    const plural = key + 's';
    if (plural !== key && phraseCounts.has(plural)) {
      totalCount += phraseCounts.get(plural)!;
      processed.add(plural);
    }

    processed.add(key);
    merged.set(key, totalCount);
    mergedOriginals.set(key, phraseOriginals.get(key) || key);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]);

  for (const [key, count] of sorted) {
    const isSingleWord = !key.includes(' ');
    if (isSingleWord && count < 3) continue;
    if (!isSingleWord && count < 2) continue;

    const term = mergedOriginals.get(key) || key;
    if (seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    result.push(term);
  }

  return result;
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

  // Parse NLP once and share the doc for both named entities and frequent terms
  const doc = nlp(fullText);

  const namedEntities = extractNamedEntities(doc);
  for (const entity of namedEntities) {
    glossaryMap.set(entity, 'KEEP');
  }

  const frequentTerms = extractFrequentTerms(doc);
  for (const term of frequentTerms) {
    if (!glossaryMap.has(term)) {
      glossaryMap.set(term, 'KEEP');
    }
  }

  for (const term of emphasizedTerms) {
    const trimmed = term.trim();
    if (trimmed.length > 1 && trimmed.length < 80) {
      glossaryMap.set(trimmed, 'KEEP');
    }
  }

  const allTerms = [...glossaryMap.keys()];
  // Sort by length descending: process longer terms first so shorter
  // subsumed terms are naturally skipped during deduplication.
  allTerms.sort((a, b) => b.length - a.length);

  const filtered: string[] = [];
  for (const term of allTerms) {
    if (filtered.some(kept => kept.includes(term))) continue;
    filtered.push(term);
  }

  const result: GlossaryEntry[] = [];
  for (const term of filtered) {
    result.push({ term, translation: glossaryMap.get(term)! });
  }

  result.sort((a, b) => b.term.length - a.term.length);

  return result;
}
