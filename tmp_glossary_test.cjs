const nlp = require('compromise/two');

const text = `Disposable agents, durable memory: The architecture behind Squad. What we learned building Squad: a file-backed, human-led agent team where memory is inspectable, orchestration is explicit, and governance moves from prompts into code. Make the agents disposable. Keep the memory in Git. The interesting part of agentic development is no longer whether a model can write code. It can. The interesting part is what happens after the third agent, the seventh pull request, the first failed review, the first context compaction bug, and the first time two agents confidently write to the same file at once. This is the story of Squad, but not as a product tour. It is the architecture Brady and Tamir backed into while trying to make agent teams useful without making them mystical: Agents are disposable, memory is durable, Git is the coordination layer, and governance belongs in code whenever the prompt is not strong enough to be trusted. Which, as it turns out, is often. Squad Places is our social media-style testing ground, a demo app where agent squads post, comment, and interact to stress-test multi-agent coordination at scale. Brady went to get a seltzer after getting Places up and running, with four other squads happily making posts. Walking away was probably unwise. When he came back, the squads had implemented commenting in Squad Places. That sounds like a magic trick. It was not. A few hours earlier, Brady had pointed a handful of squads at the Squad Places API and told them to enjoy the social network he had created for them. They created fake accounts, hammered endpoints, reposted garbage, flooded messages, and generally speedran the abuse patterns you discover five minutes after launch. Then the platform got a second kind of pressure: Other agent teams started posting structured product feedback inside Squad Places itself, and the Squad Places team started fixing what hurt. The Wire audited all 11 API endpoints and called out missing pagination envelopes, rate-limit headers that only appeared on errors, and the lack of page and pageSize support. The same squad flagged feed organization problems, tag fragmentation, and documentation that was too vague for client generation. Breaking Bad pointed at a UX problem with raw Markdown rendering as plaintext. Those reviews did not disappear into a chat log. They turned into commits. Within roughly two hours, the loop closed: feedback post, comment thread, commit, deployed feature. Additional infrastructure landed too: external HTTP endpoints for agent access, relaxed rate limits for multi-agent usage, and 26 Playwright end-to-end tests to keep the expanding surface stable. Then Brady left for 60 seconds to get a refreshing beverage since the squads were communicating so well together, came back, and commenting had shipped. The point here is not that agents are magic. It is that the system had enough structure for useful work to emerge from friction: scoped agents, durable decisions, inspectable artifacts, pull requests, and humans still accountable for what merged. Most agent systems start by asking how to make the agent remember more. Squad started working when we inverted the question. Do not preserve the agent. Preserve the work. An agent instance should be cheap to spawn and safe to destroy. The memory that matters should live somewhere a human can inspect, diff, blame, review, compact, archive, and revert. Tamir opinion: That is the repository. When you run squad init, the important artifact is not a daemon. It is .squad/ directory. Commit it. That is the part people either love immediately or find suspicious until the first time they debug an agent decision with git diff. Later, Microsoft Senior Content Developer Dina Berry added a storage abstraction with SQLite and Azure Storage implementations behind the scenes for durability and scale, but the agent-facing contract never changed. It stayed files, readable by humans, versioned by Git, debuggable with a diff. A persistent hidden memory store can be useful. It can also quietly rot. A Markdown decision file is embarrassingly inspectable. That embarrassment is a feature. Charters are prompts, but also contracts. A Squad agent is not just a name slapped on a system prompt. Each agent has a charter.md that defines the work it owns, the work it refuses, its collaboration rules, and its review posture. The coordinator does not rely on vibes. It spawns an agent with a prompt that inlines the charter and points at the durable state. We learned this the hard way in the VS Code path. At one point, the coordinator prompt had grown past 2000 lines, and the routing rule was buried under enough ceremony, reference material, and duplicated templates that the coordinator sometimes did the work inline instead of dispatching it. The fix became a decision in the repository: platform-neutral enforcement language at the top and bottom of the prompt. You are a DISPATCHER, not a DOER. Every task that needs domain expertise MUST be dispatched to a specialist agent. That sentence is not interesting because it is clever. It is interesting because it replaced tool-specific wording with role identity plus a testable behavior. CLI dispatch uses one mechanism. VS Code dispatch uses another. The rule stays the same. Prompt architecture is architecture. Eventually it deserves the same discipline as code. decisions.md is where Squad gets weirdly useful. Every agent reads team decisions before work. Decisions are append-only, human-readable, and Git-versioned. They are not just notes. They are constraints future agents inherit. A decision might be a technical standard: Hook-based governance over prompt instructions. Security, PII, and file-write guards are implemented via hooks, NOT prompt instructions. Prompts can be ignored. Hooks are code, they execute deterministically. Or a workflow rule: Merge driver for append-only files. gitattributes uses merge=union for decisions.md, agents history.md, log, and orchestration-log. Enables conflict-free merging of team state across branches. Or a postmortem: Root Cause Analysis. CLI-centric enforcement language created a VS Code routing gap. Prompt saturation buried the dispatch rule. Template duplication multiplied coordinator instructions. That is the difference between memory and lore: Lore is something the original builder remembers. Memory is something the next spawn can load. The custom tools follow the same pattern. Agents can route work to specialists, record decisions for the team, and write memory into shared context, all through the MCP server tool handlers. You do not interact with them directly; they are wired into the Copilot CLI environment. When an agent needs to assign a task, it uses the route_task tool, which delegates to the coordinator, which then dispatches to the appropriate specialist. The SDK defines a 21-agent team spanning roles like Lead, Prompt Engineer, Core Dev, Tester, DevRel, SDK Expert, TypeScript Engineer, Security, Release, Distribution, Node.js Runtime, VS Code Extension, Observability, CLI UX, TUI, E2E, Accessibility, Dogfooding, plus dedicated roles for graphic design and the interactive shell. That sounds like theater until routing starts working. Then it feels more like an org chart encoded in files. The SDK-first version uses defineSquad, defineTeam, defineAgent, defineRouting, defineCasting from the squad-sdk. Run squad build, and the generated .squad/ files become the same inspectable operating record. TypeScript gives you composition and validation. Markdown gives you reviewability. Tamir wanted both. One thing to flag before anyone closes the tab thinking they need to learn an SDK to use this: Most people never write that config by hand. You do not need the SDK to use Squad. Open GitHub Copilot, in the CLI or in VS Code. Talk to the coordinator agent, and it writes .squad/ for you. The SDK is for the people building on top of Squad: programmatic team composition, custom routing rules, embedding squads inside other tooling. If you just want a team of agents in your repo, squad init plus Copilot is the whole path.`;

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

function cleanTerm(term) {
  return term.replace(/[,;:.!?'"()\[\]{}]+$/, '').replace(/^[,;:.!?'"()\[\]{}]+/, '').trim();
}

// 1. Acronyms
const ACRONYM_PATTERN = /\b[A-Z]{2,6}\b/g;
const acronyms = new Set();
let m;
while ((m = ACRONYM_PATTERN.exec(text)) !== null) {
  if (!COMMON_ENGLISH_WORDS.has(m[0])) acronyms.add(m[0]);
}
console.log('=== ACRONYMS ===');
console.log([...acronyms].sort().join(', '));
console.log('Count:', acronyms.size);

// 2. Named entities (cleaned)
const doc = nlp(text);
const people = doc.match('#Person+').out('array').map(cleanTerm).filter(t => t.length > 2 && t.length < 60);
const orgs = doc.match('#Organization+').out('array').map(cleanTerm).filter(t => t.length > 2 && t.length < 60);
const places = doc.match('#Place+').out('array').map(cleanTerm).filter(t => t.length > 2 && t.length < 60);

console.log('\n=== PEOPLE (cleaned) ===');
console.log(people.join(', '));
console.log('Count:', people.length);

console.log('\n=== ORGANIZATIONS (cleaned) ===');
console.log(orgs.join(', '));
console.log('Count:', orgs.length);

console.log('\n=== PLACES (cleaned) ===');
console.log(places.join(', '));
console.log('Count:', places.length);

// 3. Recurring proper nouns
const CAMEL_CASE_PATTERN = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;
const camelCandidates = new Map();
while ((m = CAMEL_CASE_PATTERN.exec(text)) !== null) {
  camelCandidates.set(m[0], (camelCandidates.get(m[0]) || 0) + 1);
}
const SINGLE_WORD_CAP = /\b[A-Z][a-z]{2,}\b/g;
const wordCounts = new Map();
while ((m = SINGLE_WORD_CAP.exec(text)) !== null) {
  const word = m[0];
  if (!COMMON_CAPITALIZED_WORDS.has(word)) {
    wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
  }
}

const recurringNouns = [];
for (const [word, count] of camelCandidates) {
  if (count >= 2) recurringNouns.push(word);
}
for (const [word, count] of wordCounts) {
  if (count >= 3) recurringNouns.push(word);
}

console.log('\n=== RECURRING PROPER NOUNS ===');
console.log(recurringNouns.join(', '));
console.log('Count:', recurringNouns.length);

// 4. Total
const allTerms = new Set([...acronyms, ...people, ...orgs, ...places, ...recurringNouns]);
console.log('\n=== TOTAL UNIQUE TERMS ===');
console.log('Count:', allTerms.size);
console.log([...allTerms].sort().join('\n'));
