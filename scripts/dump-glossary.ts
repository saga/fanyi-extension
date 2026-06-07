// Quick script to dump the actual glossary produced for a real article.
import { extractGlossaryLocal } from '../src/entrypoints/utils/glossaryExtractor';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(resolve(__dirname, 'article.txt'), 'utf-8');

console.log('=== Article stats ===');
console.log('Length:', text.length, 'chars');
console.log('Words:', text.split(/\s+/).length);

const glossary = extractGlossaryLocal(text);
console.log('\n=== Glossary ===');
console.log('Total terms:', glossary.length);
console.log('Char count (raw):', glossary.reduce((s, e) => s + e.term.length, 0));
console.log('---');
for (const entry of glossary) {
  console.log(`- ${entry.term}`);
}
