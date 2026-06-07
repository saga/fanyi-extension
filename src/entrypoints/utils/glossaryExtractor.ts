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
  'AND', 'ARE', 'BUT', 'ALL', 'CAN', 'HAS', 'HER', 'WAS', 'ONE', 'OUR',
  'OUT', 'USE', 'VIA', 'WHO', 'ITS', 'MAY', 'NOR', 'NOT', 'FOR', 'THE',
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

// Match "obvious" acronyms — must contain at least 2 uppercase letters
// (or be all-caps). This is restrictive on purpose: it catches API, NAT,
// eBPF, gRPC, iOS, NaN, POSTGRESQL, and skips ordinary capitalized
// sentence words (The, It, How) which have only 1 uppercase letter.
//
//   [A-Z]{2,}                 — all-caps, 2+ chars: API, NAT, HTTP, POSTGRESQL
//   [a-z][A-Z][A-Z][A-Za-z]*  — prefix-lower then 2 caps: eBPF, gRPC, iOS
//   [A-Z][a-z]+[A-Z][A-Za-z]* — inner-cap: GitHub, OpenAIs, NodeJs
const ACRONYM_PATTERN = /\b(?:[A-Z]{2,}|[a-z][A-Z][A-Z][A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/g;

function cleanTerm(term: string): string {
  return term
    .replace(/[,;:.!?'"()\[\]{}]+$/, '')
    .replace(/^[,;:.!?'"()\[\]{}]+/, '')
    // Strip possessive 's so "Netflix's" becomes "Netflix" — without this
    // compromise's NER produces "Netflix's Service" as a single token and we
    // miss the actual proper noun.
    .replace(/['']s$/i, '')
    .trim();
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

  // compromise's NER is unreliable on short articles: #Organization+ misses
  // most brand names, and #ProperNoun+ tags every sentence-initial word as a
  // proper noun ("The", "It", "How"). We rely on:
  //   1. compromise's #Acronym+ for any token it does identify
  //   2. A CamelCase regex for multi-cap identifiers (handles eBPF, gRPC)
  //   3. Capitalized tokens NOT at sentence start for single-cap brand names
  //      like Kafka, Apache, Stripe (filtered against a stoplist of common
  //      English capitalized words that appear mid-sentence).
  //
  // Important: we keep only SINGLE-word entities here. Multi-word phrase
  // fragments from compromise ("Netflix's service count") leak too much
  // context and dedup poorly — the "Netflix" token is what we actually want.
  const fullText = doc.text();

  // (1) compromise-detected acronyms (fallback for anything our regex misses).
  // We accept only single tokens here; multi-word phrase fragments like
  // "OpenTelemetry's Service" leak the wrong context. We also filter against
  // ACRONYM_EXCLUSIONS — compromise's #Acronym+ is naive and tags any
  // all-caps token (e.g. "DOER", "MUST") as an acronym, so we apply the
  // same exclusions the regex path uses.
  for (const ac of doc.match('#Acronym+').out('array')) {
    const cleaned = cleanTerm(ac);
    if (cleaned.length >= 2 && cleaned.length < 20 && !cleaned.includes(' ')) {
      if (ACRONYM_EXCLUSIONS.has(cleaned.toUpperCase())) continue;
      if (isCommonNoun(cleaned)) continue;
      entities.add(cleaned);
    }
  }

  // (1b) compromise-detected organizations — also single-token only.
  for (const org of doc.match('#Organization+').out('array')) {
    const cleaned = cleanTerm(org);
    if (cleaned.length >= 2 && cleaned.length < 20 && !cleaned.includes(' ')) {
      if (isCommonNoun(cleaned)) continue;
      entities.add(cleaned);
    }
  }

  // (2) CamelCase identifiers — only when NOT at sentence start.
  // Skip all-caps words (handled by extractAcronyms + ACRONYM_EXCLUSIONS).
  // We want mixed-case identifiers: GitHub, Apache, eBPF, gRPC.
  const brandRegex = /(?<=\s)([A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/g;
  for (const m of fullText.matchAll(brandRegex)) {
    const word = m[1];
    if (isCommonNoun(word)) continue;
    entities.add(word);
  }

  // (3) Single-cap brand names — when NOT at sentence start.
  const singleCapRegex = /(?<=[a-z,;:] )([A-Z][a-z]{2,})\b/g;
  for (const m of fullText.matchAll(singleCapRegex)) {
    const word = m[1];
    if (isCommonNoun(word)) continue;
    if (STOPWORDS.has(word.toLowerCase())) continue;
    entities.add(word);
  }

  return [...entities];
}

// Mid-sentence capitalized words that aren't product/brand names. This is
// shorter than the full stopword list because proper-noun grammar in
// English is much narrower than what we have to filter.
const COMMON_NOUN_FALSE_POSITIVES = new Set([
  // sentence-initial words that survived lookbehind filtering
  'How', 'Why', 'When', 'Where', 'What', 'Which', 'Who',
  // common nouns that look like brand names
  'Today', 'Tomorrow', 'Yesterday', 'Nothing', 'Everything', 'Something',
  'Anything', 'Everyone', 'Anyone', 'Someone', 'Nobody', 'Everybody',
  'Each', 'Every', 'Other', 'Another', 'Either', 'Neither',
  'Most', 'Some', 'Many', 'Several', 'Few', 'All', 'Both', 'None',
  'Future', 'Past', 'Present', 'Now', 'Then', 'Here', 'There',
  'Above', 'Below', 'Inside', 'Outside', 'Before', 'After', 'During',
  'Until', 'Since', 'While', 'Because', 'Although', 'However',
  'Moreover', 'Furthermore', 'Therefore', 'Otherwise', 'Instead',
  'Besides', 'Anyway', 'Somewhere', 'Nowhere', 'Everywhere',
  'People', 'Year', 'Day', 'Week', 'Month', 'Time', 'Real', 'End',
  'Beginning', 'Start', 'Middle', 'Top', 'Bottom', 'Left', 'Right',
  'Front', 'Back', 'Up', 'Down', 'Side', 'Part', 'Section',
  'Chapter', 'Page', 'Figure', 'Table', 'Section', 'Appendix',
  'Section', 'Note', 'Warning', 'Caution', 'Tip', 'Example',
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  // domain-generic tech terms that look brand-ish
  'Microservices', 'Microservice', 'Services', 'Service', 'Topology', 'Connector',
  'Architecture', 'Pipeline', 'Aggregator', 'Stream', 'Streams',
  'Consumer', 'Producer', 'Broker', 'Cluster', 'Node', 'Nodes',
  'Worker', 'Workers', 'Shard', 'Shards', 'Layer', 'Layers',
  'Gateway', 'Gateways', 'Balancer', 'Balancers', 'Database', 'Databases',
  'Query', 'Queries', 'Index', 'Snapshot', 'Snapshots', 'Cache', 'Bucket',
  'Endpoint', 'Endpoints', 'Protocol', 'Protocols', 'Metric', 'Metrics',
  'Trace', 'Tracer', 'Spans', 'Span', 'Log', 'Logs', 'Filter', 'Filters',
  'Graph', 'Graphs', 'Node', 'Nodes', 'Edge', 'Edges', 'Vertex', 'Vertices',
  'Table', 'Tables', 'Column', 'Columns', 'Row', 'Rows', 'Field', 'Fields',
  'View', 'Views', 'Model', 'Models', 'Schema', 'Index', 'Constraint',
  'Tier', 'Tiers', 'Region', 'Regions', 'Zone', 'Zones', 'Domain', 'Domains',
  'Flow', 'Logs', 'Path', 'Paths', 'Edge', 'Edges', 'Source', 'Sources',
  'Request', 'Response', 'Status', 'Payload', 'Header', 'Headers',
  'Service', 'Services', 'Process', 'Process', 'Thread', 'Threads',
  'Context', 'Scope', 'Token', 'Tokens', 'Session', 'Sessions',
  'Pipeline', 'Pipelines', 'Job', 'Jobs', 'Task', 'Tasks', 'Batch', 'Batches',
]);

function isCommonNoun(word: string): boolean {
  return COMMON_NOUN_FALSE_POSITIVES.has(word);
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

      // Reject phrases that contain a possessive suffix. "Netflix's service
      // count" is a fragment; the brand token is "Netflix" (handled by the
      // proper-noun extractor). Allowing possessives in frequent terms just
      // creates phrase-shaped noise in the glossary.
      if (/['']s\b/.test(cleaned)) continue;
      // Reject phrases where every word is generic English (Topology, Stream,
      // Architecture etc.). These appear repeatedly but aren't translation-
      // worthy glossary entries.
      if (words.every((w) => isCommonNoun(w))) continue;

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
    if (filtered.some(kept => isPhraseSubsuming(kept, term))) continue;
    filtered.push(term);
  }

  const result: GlossaryEntry[] = [];
  for (const term of filtered) {
    result.push({ term, translation: glossaryMap.get(term)! });
  }

  // Score each term: higher = more important to keep. We cap at MAX_GLOSSARY_TERMS
  // to bound the per-chunk cost — longer prefix in the system prompt directly
  // translates to more tokens across all chunks of a page.
  const scored = result
    .map((entry) => ({ entry, score: scoreTerm(entry.term, fullText) }))
    .filter((s) => !isGenericNoise(s.entry.term))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, MAX_GLOSSARY_TERMS).map((s) => s.entry);
}

// Common technical/abstract nouns that compromise's NER surfaces as
// "named entities" but are actually domain-generic and not worth translating
// in a glossary. They get filtered before scoring.
const GENERIC_NOISE = new Set([
  'services', 'service', 'systems', 'system', 'traces', 'trace',
  'tools', 'tool', 'logs', 'log', 'metrics', 'metric', 'data',
  'engineers', 'engineer', 'teams', 'team', 'users', 'user',
  'context', 'details', 'support', 'requests', 'request',
  'queries', 'query', 'edges', 'edge', 'paths', 'path',
  'sources', 'source', 'levels', 'level', 'environments', 'environment',
  'solutions', 'solution', 'attempts', 'attempt', 'patterns', 'pattern',
  'questions', 'question', 'failures', 'failure', 'changes', 'change',
  'views', 'view', 'layers', 'layer', 'snapshots', 'snapshot',
  'workloads', 'workload', 'hops', 'hop', 'gateways', 'gateway',
  'balancers', 'balancer', 'events', 'event', 'pipelines', 'pipeline',
  'connections', 'connection', 'storage', 'costs', 'cost',
  'incidents', 'incident', 'limitations', 'limitation',
  'processors', 'processor', 'consumers', 'consumer',
  'protocols', 'protocol', 'endpoints', 'endpoint',
  'dependencies', 'dependency', 'graphs', 'graph',
  'response', 'requirement', 'requirements',
  'multi-region', 'real-time', 'sub-second',
]);

function isGenericNoise(term: string): boolean {
  const normalized = term.toLowerCase().trim();
  if (GENERIC_NOISE.has(normalized)) return true;
  // Drop lowercase plural-form generic nouns. We only do this for
  // single-word plurals (no spaces) since proper nouns like "Apache Pekko
  // Streams" need their trailing 's' preserved.
  if (
    !term.includes(' ') &&
    /^[a-z]+s$/.test(normalized) &&
    normalized.length <= 10
  ) {
    return true;
  }
  return false;
}

// Decide whether `kept` should subsume (eat) `term` during dedup.
// Only multi-word phrases swallow a single word — we never drop a bare
// acronym like "eBPF" just because "eBPF network flow logs" was seen first.
function isPhraseSubsuming(kept: string, term: string): boolean {
  // Don't subsume one single word with another single word
  if (!kept.includes(' ') && !term.includes(' ')) return false;

  // Multi-word phrase subsumes a single word it contains (with word boundary)
  if (kept.includes(' ') && !term.includes(' ')) {
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');
    return re.test(kept);
  }

  // Multi-word phrase subsumes a sub-phrase it contains
  if (kept.includes(' ') && term.includes(' ')) {
    return kept.toLowerCase().includes(term.toLowerCase());
  }

  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Priority order — the order itself is the contract. Tweak the weights
// below rather than reordering this list.
const ACRONYM_BONUS = 1000;
const PROPER_NOUN_BONUS = 500;
const LENGTH_WEIGHT = 10;        // longer term = rarer = more important
const FREQUENCY_WEIGHT = 1;      // more occurrences = more important
const MAX_GLOSSARY_TERMS = 50;

function scoreTerm(term: string, fullText: string): number {
  // 1. Acronym (ALL CAPS, 2-6 letters) — almost always a real product/standard
  if (/^[A-Z]{2,6}$/.test(term)) return ACRONYM_BONUS + term.length * LENGTH_WEIGHT;

  // 2. Proper noun or CamelCase identifier — product/feature/tech names
  //    ("React", "JavaScript", "GitHub", "Node.js" all match one of these)
  const hasUpper = /[A-Z]/.test(term);
  const startsUpper = /^[A-Z]/.test(term);
  if (hasUpper && (startsUpper || /[a-z]/.test(term))) {
    return PROPER_NOUN_BONUS + term.length * LENGTH_WEIGHT;
  }

  // 3. Lowercase / generic term — fall back to frequency + length
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const occurrences = (fullText.match(new RegExp(`\\b${escaped}\\b`, 'gi')) || []).length;
  return occurrences * FREQUENCY_WEIGHT + term.length * LENGTH_WEIGHT * 0.1;
}
