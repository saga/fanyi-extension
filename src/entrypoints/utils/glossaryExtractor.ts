import nlp from 'compromise/two';
import type { GlossaryEntry } from '../service/_service';
import techProductsData from './tech-products.json';

const TECH_PRODUCTS = new Set<string>(techProductsData.products as string[]);
const KNOWN_PUBLICATIONS = new Set<string>(
  (techProductsData.publications as string[]).flatMap((p) => p.toLowerCase().split(/\s+/))
);
const FULL_PUBLICATIONS = techProductsData.publications as string[];

// Tech-domain anchors — when a frequent-phrase candidate contains one of
// these, it gets promoted into the glossary even with a single occurrence
// (the normal threshold is >= 2 for multi-word phrases). Example: "agentic
// AI" contains the anchor "AI" and should not be filtered out for low freq.
const TECH_ANCHORS = new Set([
  'AI', 'ML', 'LLM', 'RAG', 'NLP', 'GPU', 'CPU', 'TPU', 'NPU', 'FPGA', 'ASIC',
  'API', 'REST', 'GraphQL', 'gRPC', 'SQL', 'NoSQL', 'MCP', 'RBAC', 'PII',
  'TLS', 'SSL', 'SDK', 'IDE', 'CDN', 'DDoS', 'SaaS', 'PaaS', 'IaaS', 'FaaS',
  'ETL', 'ELT', 'CI', 'CD', 'JVM', 'WASM', 'K8s',
  'Kafka', 'Flink', 'Spark', 'Airflow', 'Superset', 'Beam', 'Storm',
  'Terraform', 'Ansible', 'Pulumi', 'Crossplane', 'Helm',
  'dbt', 'Postgres', 'Redis', 'MongoDB', 'Elasticsearch', 'ClickHouse',
  'Docker', 'Kubernetes', 'Nomad', 'Consul', 'Vault',
  'TimesFM', 'PyTorch', 'TensorFlow', 'LangChain', 'LangGraph', 'Ollama',
]);

// Phrase keys in extractFrequentTerms() are lowercased before comparison.
// Use a parallel lowercased set so anchor checks (TECH_ANCHORS.has(...)) work
// against lowercased tokens, not the canonical-case form. Without this, "AI"
// in the anchor set would never match the lowercased "ai" extracted from
// text — see "agentic AI" / "Flink SQL" false negatives.
const TECH_ANCHORS_LOWER = new Set(
  [...TECH_ANCHORS].map((w) => w.toLowerCase())
);

// Tail nouns that, when they appear as the last word in a multi-word phrase,
// indicate generic phrasing rather than a glossary-worthy term. "AI apps",
// "AI services", "developer tools" all fall in this bucket — they're
// "AI stuff" rather than a specific product or concept.
const BLOCKED_TAIL_NOUNS = new Set([
  'apps', 'services', 'tools', 'users', 'systems', 'solutions', 'platforms',
  'products', 'projects', 'features', 'components', 'modules',
  'issues', 'questions', 'topics', 'items', 'things', 'stuff', 'aspects',
  'elements', 'factors', 'areas', 'parts', 'pieces',
]);

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
  'put', 'set', 'add', 'keep', 'start', 'stop', 'turn', 'call',
  'work', 'seem', 'feel', 'leave', 'bring', 'begin',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
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
  'customer', 'server', 'database', 'network', 'process', 'model', 'tool',
  'feature', 'platform', 'product', 'project', 'team', 'user',
  // Contraction leftovers: cleanTerm() strips apostrophes so "I've" becomes
  // "Ive", "don't" becomes "dont", etc. These aren't real glossary terms.
  'ive', 'dont', 'youre', 'were', 'theyre', 'im', 'id', 'ill', 'hes', 'shes',
  'morning', 'reason', 'research', 'girl', 'guy', 'moment', 'air',
  'teacher', 'force', 'education', 'foot', 'boy', 'age', 'policy',
  'music', 'market', 'sense', 'thing', 'things', 'love', 'class', 'state',
  'don', 'doesn', 'didn', 'won', 'wasn', 'weren', 'isn', 'aren',
  'hasn', 'haven', 'hadn', 'wouldn', 'couldn', 'shouldn', 'mustn',
  've', 'll', 're', 'shan',
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
  'PART', 'GOOD', 'LOOK', 'COME', 'CALL', 'KEEP', 'GIVE',
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
    // Strip common punctuation from both ends, including trailing dashes
    // (so "API-" in "API-first" doesn't sneak through as a glossary entry).
    .replace(/^[,;:.!?'"“”‘’()\[\]{}\-–—#*_/\\|<>~`\s]+/, '')
    .replace(/[,;:.!?'"“”‘’()\[\]{}\-–—#*_/\\|<>~`\s]+$/, '')
    // Strip possessive 's and standalone "I've"/"we've" contractions — these
    // are sentence fillers, not glossary terms. Match both straight and
    // smart (typographic) apostrophes since real-world text uses both.
    .replace(/['’]s$/i, '')
    // Split on glued periods from bad formatting (e.g. "Falconer.The")
    .split(/\.[A-Z]/)[0]
    // If a contraction remains, the whole token is one (e.g. "I've", "we're").
    // Drop it by replacing the apostrophe with an empty string AFTER we've
    // pulled the rest — but easier: if it still contains an apostrophe,
    // blank it. Compromise tags these as nouns surprisingly often.
    .replace(/['’]/g, '')
    .trim();
}

function extractAcronyms(text: string): string[] {
  const found = new Map<string, number>();
  // Use matchAll rather than .exec() on a global regex — matchAll
  // creates a fresh internal regex copy per call so the
  // ACRONYM_PATTERN's `lastIndex` is never shared across calls
  // (which would otherwise silently skip matches on the second
  // invocation in the same context).
  for (const match of text.matchAll(ACRONYM_PATTERN)) {
    const word = match[0];
    if (!ACRONYM_EXCLUSIONS.has(word)) {
      found.set(word, (found.get(word) || 0) + 1);
    }
  }
  const result: string[] = [];
  for (const [word, count] of found) {
    if (/^[A-Z]{5,}$/.test(word) && !/\d/.test(word) && count < 2) {
      continue;
    }
    result.push(word);
  }
  return result;
}

function extractNamedEntities(doc: ReturnType<typeof nlp>): string[] {
  const entities = new Set<string>();
  const fullText = doc.text();

  // Build a set of token-offset ranges that are possessives (e.g. "Netflix's"),
  // so we can drop the bare brand token rather than the fragmented phrase
  // ("Netflix's service count") that compromise sometimes emits.
  const possessiveRanges: Array<[number, number]> = [];
  for (const text of doc.match('#Possessive+').out('array')) {
    const offset = fullText.indexOf(text);
    if (offset >= 0) possessiveRanges.push([offset, offset + text.length]);
  }
  const isPossessive = (word: string): boolean => {
    let idx = fullText.indexOf(word);
    if (idx < 0) return false;
    let allPossessive = true;
    while (idx >= 0) {
      const inRange = possessiveRanges.some(([s, e]) => idx >= s && idx < e);
      if (!inRange) {
        allPossessive = false;
        break;
      }
      idx = fullText.indexOf(word, idx + 1);
    }
    return allPossessive;
  };

  // (1) compromise's acronyms() method is the most accurate acronym source —
  // it correctly tags "API", "POSTGRESQL" and skips ordinary all-caps words
  // (DOER, MUST) that the regex / #Acronym+ naively match. We also apply
  // ACRONYM_EXCLUSIONS as a defensive belt-and-suspenders pass.
  // The `acronyms` / `people` methods are declared on `three`'s View but
  // not on `two`'s; module augmentation in src/types/compromise-two.d.ts
  // extends the `two` View so we can call them without `as unknown as`.
  if (typeof doc.acronyms === 'function') {
    for (const ac of doc.acronyms().out('array')) {
      const cleaned = cleanTerm(ac);
      if (cleaned.length < 2 || cleaned.length >= 20) continue;
      if (cleaned.includes(' ')) continue;
      if (ACRONYM_EXCLUSIONS.has(cleaned.toUpperCase())) continue;
      if (isCommonNoun(cleaned)) continue;
      if (/^[A-Z]{5,}$/.test(cleaned) && !/\d/.test(cleaned)) {
        const occurrences = (fullText.match(new RegExp(`\\b${cleaned}\\b`, 'g')) || []).length;
        if (occurrences < 2) continue;
      }
      entities.add(cleaned);
    }
  }

  // (2) People — compromise's .people() returns full names like "Sean
  // Falconer". We accept these and also strip the bare first/last tokens so
  // translations can match either form.
  if (typeof doc.people === 'function') {
    for (const person of doc.people().out('array')) {
      const cleaned = cleanTerm(person);
      if (cleaned.length < 2) continue;
      if (cleaned.includes(' ')) {
        // Full multi-token name → also add individual tokens.
        for (const tok of cleaned.split(/\s+/)) {
          if (tok.length >= 2 && !isCommonNoun(tok) && !isStopword(tok)) {
            entities.add(tok);
          }
        }
      } else {
        if (!isCommonNoun(cleaned) && !isStopword(cleaned)) entities.add(cleaned);
      }
    }
  }

  // (3) CamelCase identifiers (NOT at sentence start). Skips all-caps words
  // which are already handled by acronyms(). We want mixed-case identifiers
  // like GitHub, Apache, eBPF, gRPC.
  const brandRegex = /(?:^|[^a-zA-Z0-9])([A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/g;
  for (const m of fullText.matchAll(brandRegex)) {
    const word = m[1];
    if (isCommonNoun(word)) continue;
    if (isPossessive(word)) continue;
    entities.add(word);
  }

  // (4) Single-cap brand names — when NOT at sentence start.
  const singleCapRegex = /(?<=[a-z,;:] )([A-Z][a-z]{2,})\b/g;
  for (const m of fullText.matchAll(singleCapRegex)) {
    const word = m[1];
    if (isCommonNoun(word)) continue;
    if (STOPWORDS.has(word.toLowerCase())) continue;
    if (isPossessive(word)) continue;
    // Drop single-word pieces of known publications. "Stack" is ambiguous
    // ("LAMP stack", "tech stack") — only the full form "The New Stack" is
    // worth translating as a publication name.
    if (KNOWN_PUBLICATIONS.has(word.toLowerCase())) continue;
    entities.add(word);
  }

  // (5) Known publications: scan for full multi-word publication names
  // (e.g. "The New Stack", "The Register") and add the canonical form. This
  // ensures the brand + qualifiers stick together in the glossary.
  for (const pub of FULL_PUBLICATIONS) {
    if (fullText.toLowerCase().includes(pub.toLowerCase())) {
      entities.add(pub);
    }
  }

  // (6) ProperNouns — compromise's #ProperNoun+ catches single-word brand
  // names (Microsoft, Google) that the brandRegex/singleCapRegex miss. We
  // filter aggressively: drop stopwords, short tokens, and common nouns.
  //
  // The earlier "exclude any word that ever appears at sentence start"
  // heuristic was wrong: a brand mentioned both as sentence-initial
  // ("Microsoft announced...") and mid-sentence ("...than Microsoft") got
  // wrongly filtered. Instead, exclude a word only when EVERY occurrence
  // is sentence-initial — i.e. we have no evidence that it's used as a
  // proper noun mid-sentence. compromise/two's .sentences() isn't typed,
  // so we extract sentence starts by regex against the original text.
  const sentenceStartCounts = new Map<string, number>();
  for (const m of fullText.matchAll(/(?:^|[.!?]\s+|\n)([A-Z][A-Za-z]+)/g)) {
    const w = m[1].toLowerCase();
    sentenceStartCounts.set(w, (sentenceStartCounts.get(w) || 0) + 1);
  }
  const properNounCounts = new Map<string, number>();
  for (const pn of doc.match('#ProperNoun+').out('array')) {
    const cleaned = cleanTerm(pn);
    if (cleaned.includes(' ')) continue;
    if (cleaned.length < 3) continue;
    if (isStopword(cleaned)) continue;
    if (isCommonNoun(cleaned)) continue;
    if (isPossessive(cleaned)) continue;
    if (KNOWN_PUBLICATIONS.has(cleaned.toLowerCase())) continue;
    properNounCounts.set(cleaned, (properNounCounts.get(cleaned) || 0) + 1);
  }
  for (const [word, count] of properNounCounts) {
    // Drop only when every observed occurrence of this word is at a
    // sentence boundary — i.e. compromise has no evidence the word is
    // ever used as a mid-sentence proper noun. If it appears at the
    // start of a sentence even once but also mid-sentence (e.g.
    // "Microsoft" in "Microsoft announced" + "...than Microsoft"),
    // the word is a real proper noun and we keep it.
    const startCount = sentenceStartCounts.get(word.toLowerCase()) || 0;
    if (startCount >= count) continue;
    // Q3: keep brand names that appear only once, because a single
    // mention of "Microsoft" / "Anthropic" / "Databricks" is still
    // worth pinning in the glossary. Without this, Q3's
    // ProperNoun fallback path is a no-op for one-shot brand mentions.
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
  // Generic nouns that repeat a lot in tech writing but aren't glossary-worthy.
  'Customer', 'Server', 'Database', 'Network', 'Process', 'Model', 'Tool',
  'Feature', 'Platform', 'Product', 'Project', 'User', 'Customer',
  // Fragments from hyphenated compounds (e.g. "high-stakes" → "stakes")
  // and other common domain words that aren't glossary-worthy on their own.
  'Stakes', 'Controls', 'Tooling', 'Industries', 'Agencies', 'Vendors',
  'Practices', 'Patterns', 'Concerns', 'Requirements', 'Constraints',
  'Security', 'Privacy', 'Latency', 'Throughput', 'Compliance',
  'Developer', 'Engineer', 'Operator', 'Admin', 'Architect',
]);

function isCommonNoun(word: string): boolean {
  // The list stores Title-case forms (e.g. "Service", "Pipeline"). Match
  // case-insensitively so "service"/"pipeline" mid-sentence are also
  // recognized as common nouns, not proper-noun candidates.
  if (COMMON_NOUN_FALSE_POSITIVES.has(word)) return true;
  return COMMON_NOUN_FALSE_POSITIVES.has(
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  );
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
      // Phrases that contain internal punctuation (`:`, `;`, `,`, `—`)
      // are usually sentence fragments compromise mis-tagged as noun
      // phrases — e.g. "AI development: experimentation", "leap: AI
      // agents", "AI systems; it". These are NOT glossary terms.
      if (/[,;:—–]/.test(cleaned)) continue;

      const words = cleaned.split(/\s+/);
      if (!hasSubstantiveWord(words)) continue;
      if (isStopword(words[0])) continue;
      // For single-word entries, also reject common nouns like "customer",
      // "server", "database" — they appear repeatedly in tech writing but
      // aren't glossary-worthy translation targets.
      if (words.length === 1 && isCommonNoun(words[0])) continue;
      // Drop single-word frequent candidates that look like English
      // comparative/superlative adjectives (Easier, Faster, Better) or
      // present participles used as adjectives (Building, Growing, Going).
      // compromise mis-tags these as nouns and they pollute the glossary
      // with sentence-filler words. Words ending in -ing / -er / -est with
      // a capitalized first letter are typically "Running Example: ..."
      // sentence starts, not glossary entries.
      if (words.length === 1) {
        const w = words[0];
        if (/^[A-Z][a-z]+(?:er|est|ing)$/.test(w) && !/^[A-Z]{2,}$/.test(w)) continue;
      }

      // Reject phrases that contain a possessive suffix. "Netflix's service
      // count" is a fragment; the brand token is "Netflix" (handled by the
      // proper-noun extractor). Allowing possessives in frequent terms just
      // creates phrase-shaped noise in the glossary.
      if (/['']s\b/.test(cleaned)) continue;
      // Reject phrases where every word is generic English (Topology, Stream,
      // Architecture etc.). These appear repeatedly but aren't translation-
      // worthy glossary entries.
      if (words.every((w) => isCommonNoun(w))) continue;
      // Reject phrases that end in a generic tail noun ("AI apps", "AI
      // services", "developer tools"). These are vague "X-stuff" phrasings
      // — not specific product or concept names worth pinning in glossary.
      // The translation model already knows how to render these.
      if (words.length >= 2 && BLOCKED_TAIL_NOUNS.has(words[words.length - 1].toLowerCase())) continue;
      // Reject single-word entries that are short and all-lowercase — these
      // are usually leftover contractions like "Ive"/"dont" rather than
      // glossary-worthy terms.
      if (words.length === 1 && cleaned.length < 4 && !/[A-Z]/.test(cleaned)) continue;

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

  // Track per-token word counts so the plural-merge step below can guard
  // against bad regex truncation ("k8s" → "k8", "graphqls" → "graphql",
  // "timeseries" → "timeserie"). We only do the simple "drop trailing s"
  // fold for genuinely English-style single words.
  const tokenWordCount = new Map<string, number>();
  for (const phrase of phraseCounts.keys()) {
    const ws = phrase.split(/\s+/);
    if (ws.length === 1) {
      tokenWordCount.set(ws[0], (tokenWordCount.get(ws[0]) || 0) + 1);
    }
  }

  for (const [key, count] of phraseCounts.entries()) {
    if (processed.has(key)) continue;

    let totalCount = count;
    // Only merge `keys` -> `key` for single-word English-like tokens
    // (length >= 4, not all-digits). Multi-word phrases don't have a
    // meaningful singular/plural fold, and short tokens like "k8s" or
    // acronyms like "RAGs" must not be truncated to "k8" / "RAG".
    const words = key.split(/\s+/);
    if (words.length === 1 && key.length >= 4 && !/^\d+$/.test(key)) {
      const singular = key.replace(/s$/, '');
      if (singular !== key && phraseCounts.has(singular) && (tokenWordCount.get(singular) || 0) > 0) {
        totalCount += phraseCounts.get(singular)!;
        processed.add(singular);
      }
    }

    const plural = key + 's';
    if (plural !== key && !processed.has(plural) && phraseCounts.has(plural)) {
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
    // Q8: phrases that contain a tech anchor (AI, SQL, Kafka, Flink, ...)
    // are kept even with count == 1. "agentic AI", "Flink SQL", "AI agents"
    // are core concepts that the translation model needs to render
    // consistently — they shouldn't be filtered out just because the
    // article doesn't repeat them. The anchor acts as a domain-trust
    // signal: the phrase is worth pinning. Look up against the lowercased
    // anchor set since `key` here is already lowercased.
    const hasAnchor = key.split(/\s+/).some((w) => TECH_ANCHORS_LOWER.has(w));
    if (isSingleWord && count < 3 && !hasAnchor) continue;
    if (!isSingleWord && count < 2 && !hasAnchor) continue;

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

  // Q7: small tech product names (dbt, redis, nginx, git, ...). These are
  // all-lowercase identifiers that no regex/Capitalization heuristic would
  // catch. They appear in tech writing without context clues, and once
  // translated literally ("dbt" → "数据库构建工具" or similar) the
  // translation is wrong. Pin them in the glossary on first appearance
  // (no count threshold — even one mention is enough).
  // Use a non-ASCII-letter boundary to avoid partial matches inside larger
  // identifiers (e.g. "git" inside "github" via adjacent word boundary, or
  // "k8s" inside "k8scluster").
  // Skip when a Title-case brand ("Terraform", "Flink", "Kafka") is already
  // in the glossary — adding a lowercase duplicate creates token waste and
  // an inconsistent glossary appearance.
  // Build one alternation regex from the whole TECH_PRODUCTS list and
  // test it against the full text once, instead of compiling + testing
  // one regex per product. With ~1000 products this is a ~1000x scan
  // speedup.
  {
    const validProducts = [...TECH_PRODUCTS].filter((p) => p.length >= 2);
    if (validProducts.length > 0) {
      const escaped = validProducts
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length); // longest first to avoid prefix shadowing
      const productRe = new RegExp(
        `(^|[^A-Za-z0-9])(?:${escaped.join('|')})([^A-Za-z0-9]|$)`,
        'gi'
      );
      for (const m of fullText.matchAll(productRe)) {
        const product = m[0].replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '');
        const exists = [...glossaryMap.keys()].some(
          (k) => k.toLowerCase() === product.toLowerCase()
        );
        if (!exists) glossaryMap.set(product, 'KEEP');
      }
    }
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

  // Q1: merge [Brand] + [CapitalizedWord] pairs that co-occur >= 2 times.
  // e.g. "Confluent" + "Intelligence" appearing next to each other in the
  // text repeatedly means "Confluent Intelligence" is the product name.
  // Without this, glossary would have both "Confluent" and "Intelligence"
  // as standalone entries and the translation model would render
  // "Intelligence" as the plain word "intelligence" rather than the
  // product name. This pattern generalizes to "Google Cloud",
  // "Azure OpenAI", "Amazon Bedrock", etc.
  // Q1 brand-merge heuristic: detect "Brand Capitalized" pairs that
  // appear ≥ 2 times in the article (e.g. "Confluent Intelligence",
  // "Microsoft Azure"). The previous implementation built a fresh
  // regex per brand and ran fullText.matchAll for each one. Instead,
  // we passively scan the text for any "CapitalizedWord CapitalizedWord"
  // pair once, then bucket counts by leading brand, so a 2000-brand
  // article takes O(N) text scans instead of O(B × N).
  const brandSet = new Set(
    allTerms.filter((t) => /^[A-Z][a-zA-Z0-9]+$/.test(t) && !isCommonNoun(t))
  );
  const pairPattern = /\b([A-Z][a-zA-Z0-9]+)\s+([A-Z][a-zA-Z]+)\b/g;
  const pairCounts = new Map<string, Map<string, number>>(); // brand -> {word -> count}
  for (const m of fullText.matchAll(pairPattern)) {
    const brand = m[1];
    if (!brandSet.has(brand)) continue;
    const word = m[2];
    if (isCommonNoun(word)) continue;
    if (isStopword(word)) continue;
    if (KNOWN_PUBLICATIONS.has(word.toLowerCase())) continue;
    let inner = pairCounts.get(brand);
    if (!inner) {
      inner = new Map<string, number>();
      pairCounts.set(brand, inner);
    }
    inner.set(word, (inner.get(word) || 0) + 1);
  }
  for (const [brand, inner] of pairCounts) {
    for (const [word, count] of inner) {
      if (count < 2) continue;
      glossaryMap.set(`${brand} ${word}`, 'KEEP');
    }
  }
  const allTerms2 = [...glossaryMap.keys()];
  // Sort by length descending: process longer terms first so shorter
  // subsumed terms are naturally skipped during deduplication.
  allTerms2.sort((a, b) => b.length - a.length);

  const uniqueTerms = new Map<string, string>();
  for (const term of allTerms2) {
    const lower = term.toLowerCase();
    if (!uniqueTerms.has(lower)) {
      uniqueTerms.set(lower, term);
    } else {
      const existing = uniqueTerms.get(lower)!;
      if (term !== term.toUpperCase() && /[a-z]/.test(term) && /^[A-Z]/.test(term)) {
        uniqueTerms.set(lower, term);
      }
    }
  }

  const filtered: string[] = [];
  for (const term of uniqueTerms.values()) {
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
    // Acronyms (LLM, GPU, SQL, CUDA, PII) are kept independently even
    // when a longer phrase like "LLM workflows" / "CUDA Toolkit" /
    // "PII scrubbing" is also present. The acronym is the load-bearing
    // glossary entry — the model can render "LLM workflows" correctly
    // from the LLM entry alone, but losing LLM entirely would let the
    // model mistranslate every other LLM mention in the article.
    if (/^[A-Z]{2,}$/.test(term)) return false;
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
