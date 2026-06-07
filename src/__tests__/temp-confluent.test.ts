import { describe, it } from 'vitest';
import { extractBlocks } from '../entrypoints/utils/blockExtractor';
import { extractGlossaryLocal } from '../entrypoints/utils/glossaryExtractor';
import fs from 'fs';

describe('Confluent Intelligence Test', () => {
  it('fetches and extracts', async () => {
    // 1. Fetch the webpage
    const res = await fetch('https://thenewstack.io/confluent-intelligence-ai-agents/');
    const html = await res.text();
    
    // 2. Put into JSDOM (already configured in vitest)
    document.body.innerHTML = html;
    
    // 3. Extract blocks to get clean text, just like the extension does
    const blocks = extractBlocks(document);
    const fullText = blocks.map(b => b.text).join('\n\n');
    
    // 4. Run the glossary extractor
    const terms = extractGlossaryLocal(fullText);
    
    console.log('\n==================================================');
    console.log('TOTAL BLOCKS EXTRACTED:', blocks.length);
    console.log('TOTAL TERMS EXTRACTED:', terms.length);
    console.log('\n--- EXTRACTED GLOSSARY TERMS ---');
    terms.forEach((t, i) => {
      console.log(`${i + 1}. ${t}`);
    });
    console.log('==================================================\n');
    
    fs.writeFileSync('confluent-result.json', JSON.stringify(terms, null, 2));
  }, 30000);
});
