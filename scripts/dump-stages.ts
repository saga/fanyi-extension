import nlp from 'compromise';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(resolve(__dirname, 'article.txt'), 'utf-8');
const doc = nlp(text);

// Mimic named entity extraction:
console.log('=== acronyms ===');
console.log((doc as any).acronyms().out('array'));

console.log('\n=== people ===');
console.log((doc as any).people().out('array'));

// brandRegex
const fullText = doc.text();
const brandRegex = /(?<=\s)([A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/g;
console.log('\n=== brandRegex matches ===');
const brandMatches: string[] = [];
for (const m of fullText.matchAll(brandRegex)) brandMatches.push(m[1]);
console.log(brandMatches);

// singleCapRegex
const singleCapRegex = /(?<=[a-z,;:] )([A-Z][a-z]{2,})\b/g;
console.log('\n=== singleCapRegex matches containing Ive ===');
for (const m of fullText.matchAll(singleCapRegex)) {
  if (m[1].toLowerCase().includes('ive')) console.log(m[1]);
}

console.log('\n=== #Noun+ containing Ive ===');
for (const n of doc.match('#Noun+').out('array')) {
  if (n.toLowerCase().includes('ive')) console.log(n);
}

