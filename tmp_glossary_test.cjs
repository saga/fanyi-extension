const nlp = require('compromise/two');

const text = `Disposable agents, durable memory: The architecture behind Squad. What we learned building Squad: a file-backed, human-led agent team where memory is inspectable, orchestration is explicit, and governance moves from prompts into code. Make the agents disposable. Keep the memory in Git. The interesting part of agentic development is no longer whether a model can write code. It can. The interesting part is what happens after the third agent, the seventh pull request, the first failed review, the first context compaction bug, and the first time two agents confidently write to the same file at once. This is the story of Squad, but not as a product tour. It is the architecture Brady and Tamir backed into while trying to make agent teams useful without making them mystical: Agents are disposable, memory is durable, Git is the coordination layer, and governance belongs in code whenever the prompt is not strong enough to be trusted. Which, as it turns out, is often. Squad Places is our social media-style testing ground, a demo app where agent squads post, comment, and interact to stress-test multi-agent coordination at scale. Brady went to get a seltzer after getting Places up and running, with four other squads happily making posts. Walking away was probably unwise. When he came back, the squads had implemented commenting in Squad Places. That sounds like a magic trick. It was not. A few hours earlier, Brady had pointed a handful of squads at the Squad Places API and told them to enjoy the social network he had created for them. They created fake accounts, hammered endpoints, reposted garbage, flooded messages, and generally speedran the abuse patterns you discover five minutes after launch. Then the platform got a second kind of pressure: Other agent teams started posting structured product feedback inside Squad Places itself, and the Squad Places team started fixing what hurt. The Wire audited all 11 API endpoints and called out missing pagination envelopes. Developer Dina Berry noticed the platform had no PII scrubbing. The TUI squad built a Markdown renderer. A third agent squad started generating UX suggestions based on the structured feedback. The SDK squad added a rate limiter. Within a day, Squad Places had commenting, rate limiting, PII scrubbing, Markdown rendering, and UX suggestions, all implemented by agents that were never specifically instructed to do any of those things. This is not a success story. This is a coordination story. The interesting part is not that agents can do things. The interesting part is that when you make memory inspectable and governance explicit, the agents start coordinating in ways that look like a functioning team, not a random swarm. The architecture we backed into has four properties that turned out to matter more than any single model capability. Agents are disposable. We do not trust agents with long-lived state. Each agent run starts from a clean slate: a prompt, a context window, and a Git worktree. When the run finishes, the agent is gone. Its outputs persist in Git commits, its logs persist in CI, but the agent process itself is destroyed. This is not a limitation. It is the core design constraint. If an agent needs to remember something, it must write it down somewhere durable. If it needs to coordinate with another agent, it must do so through a shared, inspectable medium. Disposable agents force explicit memory. Memory is durable and inspectable. All persistent state lives in Git. Agent plans live in markdown files in the repo. Task definitions live in YAML. Configuration lives in code. There is no hidden state in a running agent process that matters. If you want to know what an agent is doing, read its plan file. If you want to know what it decided, read its commit messages. If you want to know why, read its logs. This is not a new idea. It is how good operations teams have always worked: write things down, make them searchable, and never rely on someone's memory of a conversation. Git is the coordination layer. When two agents need to work on the same codebase, they do not coordinate through a central orchestrator. They coordinate through Git. They branch, they commit, they push, they merge. Conflicts are resolved the same way humans resolve them: through the normal Git workflow. This means that the coordination mechanism is exactly as reliable as Git, which is to say, very reliable. It also means that the coordination mechanism is inspectable. You can see every merge, every conflict, every resolution. Governance belongs in code. When a prompt says "be careful with user data" and an agent still leaks PII, the prompt was not enough. Governance that depends on model behavior is governance that fails under pressure. We moved governance into code: PII scrubbing runs automatically, rate limiting is enforced in middleware, and destructive operations require human approval in CI. These are not suggestions. They are code that runs whether the agent remembers the rule or not.`;

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
  'music', 'market', 'sense', 'thing', 'love', 'class', 'state',
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

function cleanTerm(term) {
  return term.replace(/[,;:.!?'"()\[\]{}]+$/, '').replace(/^[,;:.!?'"()\[\]{}]+/, '').trim();
}

function isStopword(word) {
  return STOPWORDS.has(word.toLowerCase());
}

function hasSubstantiveWord(words) {
  return words.some(w => !isStopword(w));
}

// 1. Acronyms
const ACRONYM_PATTERN = /\b[A-Z]{2,6}\b/g;
const acronyms = new Set();
let m;
while ((m = ACRONYM_PATTERN.exec(text)) !== null) {
  if (!ACRONYM_EXCLUSIONS.has(m[0])) acronyms.add(m[0]);
}
console.log('=== ACRONYMS ===');
console.log([...acronyms].sort().join(', '));

// 2. Named entities
const doc = nlp(text);
const people = doc.match('#Person+').out('array').map(cleanTerm).filter(t => t.length > 2 && t.length < 60);
const orgs = doc.match('#Organization+').out('array').map(cleanTerm).filter(t => t.length > 2 && t.length < 60);
const places = doc.match('#Place+').out('array').map(cleanTerm).filter(t => t.length > 2 && t.length < 60);

console.log('\n=== NAMED ENTITIES ===');
console.log('People:', people.join(', '));
console.log('Orgs:', orgs.join(', '));
console.log('Places:', places.join(', '));

// 3. Frequent terms (compromise noun patterns)
const phraseCounts = new Map();
const phraseOriginals = new Map();

const doc2 = nlp(text);
const patterns = ['#Noun+', '#Noun #Gerund', '#Noun #Noun #Gerund'];
for (const pattern of patterns) {
  for (const phrase of doc2.match(pattern).out('array')) {
    const cleaned = cleanTerm(phrase);
    if (cleaned.length < 3 || cleaned.length > 60) continue;
    const words = cleaned.split(/\s+/);
    if (!hasSubstantiveWord(words)) continue;
    if (isStopword(words[0])) continue;
    const key = cleaned.toLowerCase();
    phraseCounts.set(key, (phraseCounts.get(key) || 0) + 1);
    if (!phraseOriginals.has(key)) phraseOriginals.set(key, cleaned);
  }
}

const frequentTerms = [];
const seen = new Set();
const sorted = [...phraseCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [key, count] of sorted) {
  const isSingleWord = !key.includes(' ');
  if (isSingleWord && count < 3) continue;
  if (!isSingleWord && count < 2) continue;
  const term = phraseOriginals.get(key) || key;
  if (seen.has(term.toLowerCase())) continue;
  seen.add(term.toLowerCase());
  frequentTerms.push({ term, count });
}

console.log('\n=== FREQUENT TERMS (count >= 2) ===');
for (const { term, count } of frequentTerms) {
  console.log(`  ${count}x  ${term}`);
}

// 4. Total
const allTerms = new Set([...acronyms, ...people, ...orgs, ...places, ...frequentTerms.map(f => f.term)]);
console.log('\n=== TOTAL UNIQUE TERMS ===');
console.log('Count:', allTerms.size);
console.log([...allTerms].sort().join('\n'));
