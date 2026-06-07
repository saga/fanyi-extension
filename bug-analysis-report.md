# Code Analysis and Improvement Plan: Fanyi Extension

This document outlines a detailed analysis of two core extraction utilities in the Fanyi Extension: `src/entrypoints/utils/glossaryExtractor.ts` and `src/entrypoints/utils/blockExtractor.ts`. 

The analysis reveals several logic bugs, performance inefficiencies, and type-safety issues that should be addressed to improve translation quality and extension stability.

## 1. Analysis of `src/entrypoints/utils/glossaryExtractor.ts`

This file is responsible for extracting technical glossary terms from text using NLP techniques (via the `compromise` library) and regex patterns.

### Confirmed Bugs & Logic Issues

1. **`isPossessive` Bug (Missing Non-Possessive Occurrences)**
   - **Location**: Lines 177–181
   - **Problem**: `isPossessive(word)` uses `fullText.indexOf(word)`. `indexOf` only returns the *first* occurrence of a word. If a brand name first appears possessively (e.g., `"Netflix's service..."`) and later appears normally (`"...than Netflix."`), `isPossessive` checks only the first occurrence, sees it's inside a possessive range, and returns `true`. This incorrectly drops the brand name from the glossary entirely.
   - **Fix**: The function should find *all* occurrences of the word in the text. It should only return `true` if *every single occurrence* is possessive. If even one occurrence is non-possessive, the term is a valid proper noun and should be kept.

2. **Plural-Merge Double-Counting**
   - **Location**: Lines 459–471 (`extractFrequentTerms` loop)
   - **Problem**: When iterating `phraseCounts`, if both `"model"` (count 3) and `"models"` (count 4) exist:
     - When `key` is `"model"`, the singular-merge branch does nothing (since `"model"` has no trailing `s`). Then the plural-merge branch checks `plural = "models"`, finds it, adds 4 to `totalCount` (making it 7), and marks `"models"` as processed.
     - BUT, what if `key` is `"models"` and it is iterated *first*? The singular-merge branch checks `singular = "model"`, finds it, adds 3 to `totalCount` (making it 7), and marks `"model"` as processed. Then the plural-merge branch checks `plural = "modelss"` (doesn't exist). 
     - Wait, the double counting occurs because the plural-merge logic merges the *wrong direction*. The singular-merge block merges `models` -> `model`. The plural-merge block also tries to merge `models` -> `model` but by adding `phraseCounts.get(plural)` to the *current* key's total count. If both singular and plural forms are present, they should be merged into a single canonical form (usually the singular), but the current logic can lead to unpredictable merge directions and skipped keys depending on map iteration order.
   - **Fix**: Guard the plural-merge block with `if (!processed.has(plural))`.

3. **Brand Regex Lookbehind is Too Strict**
   - **Location**: Line 224 (`/(?<=\s)([A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/g`)
   - **Problem**: The lookbehind `(?<=\s)` mandates that a whitespace character *must* immediately precede the CamelCase brand. This fails to extract brands that follow punctuation (e.g., `"(GitHub)"`, `"see GitHub"`, or if the brand is the very first word in the text).
   - **Fix**: Change the lookbehind to a non-word boundary or allow punctuation/start-of-string: `/(?:^|[^a-zA-Z0-9])([A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/g` and capture the actual word.

4. **Dead Code: `count < 1` Guard**
   - **Location**: Line 295 (`if (count < 1) continue;`)
   - **Problem**: `properNounCounts` is populated using `(get(cleaned) || 0) + 1`. The minimum count is 1. Therefore, `count < 1` is mathematically impossible and the `if` block is dead code.
   - **Fix**: Remove the dead code, as the comment above it ("keep brand names that appear only once") indicates the intention is to *allow* 1-count proper nouns, which the code already does by default.

5. **Contraction Cleanup Edge Case (`Ive`)**
   - **Location**: Lines 89-97 and 140-146
   - **Problem**: `cleanTerm` unconditionally strips apostrophes (`replace(/['’]/g, '')`). Consequently, `"I've"` becomes `"Ive"` (capital I). The stopword list contains lowercase `"ive"`, but because `"Ive"` is capitalized, it might bypass some initial stopword checks if `toLowerCase()` isn't applied consistently.
   - **Fix**: Add a specific regex replace in `cleanTerm` to drop common sentence-initial contractions completely before they lose their apostrophes.

6. **Over-Broad Generic Noise Filter**
   - **Location**: Lines 672-678 (`isGenericNoise`)
   - **Problem**: Drops any single-word term ending in "s" that is $\le$ 10 chars. This silently drops legitimate short plural technical terms like `"nodes"`, `"pods"`, `"spans"`, `"hooks"`.
   - **Fix**: Rely on the explicitly defined `GENERIC_NOISE` set rather than a blind length-based regex trap.


## 2. Analysis of `src/entrypoints/utils/blockExtractor.ts`

This file walks the DOM and extracts visible text blocks for translation while skipping noise (ads, nav bars, scripts, hidden elements).

### Confirmed Bugs & Logic Issues

1. **Inconsistent Handling of Nested `DIRECT_SET` Elements**
   - **Location**: Lines 409-415 (`grabNode`) vs Lines 474-481 (`acceptWalkerNode`)
   - **Problem**: `acceptWalkerNode` (the TreeWalker filter) *accepts* a `DIRECT_SET` element (like a `<p>`) even if it contains another `DIRECT_SET` descendant. However, `grabNode` (which runs after the walker returns the node) *rejects* it.
   - **Impact**: The TreeWalker unnecessarily wastes time descending into and yielding the parent node, only for it to be rejected immediately afterward. While functionally correct (no duplicates), it is an O(N) performance inconsistency.
   - **Fix**: Synchronize the logic so `acceptWalkerNode` rejects nodes with `DIRECT_SET` descendants exactly like `grabNode` does.

2. **Hidden Elements Miss CSS `getComputedStyle`**
   - **Location**: Lines 179-192 (`isElementHidden`)
   - **Problem**: The function only checks inline styles (`current.style.display === 'none'`). It completely misses elements hidden via CSS stylesheets (e.g., `<div class="hidden">`).
   - **Impact**: Hidden elements (like mobile menus on desktop, or collapsed ad containers) will be extracted and translated, wasting tokens and creating confusing UI replacements.
   - **Fix**: Replace inline style checks with `window.getComputedStyle(el).display === 'none'`. (Note: This is slower, so it should be used judiciously, perhaps only when the node passes all other quick checks).

3. **`lang` Attribute Promotes Elements to Articles**
   - **Location**: Line 251 (`isInsideArticle`)
   - **Problem**: `if (current.hasAttribute('lang') && tag !== 'html' && tag !== 'body') return true;`
   - **Impact**: Any localized sidebar widget or footer element with a `lang="en"` attribute is instantly promoted to "article content," bypassing strict extraction rules and pulling in noise.
   - **Fix**: Remove the `lang` check from `isInsideArticle`. The `<article>` tag and specific classes are sufficient.

4. **Type Lie in `hasTranslateBlockClass`**
   - **Location**: Lines 390-391
   - **Problem**: Uses optional chaining (`?.`) on `classList`. `Element.classList` is never undefined. If it *were* undefined, `undefined || undefined` evaluates to `undefined`. But the function signature promises a `boolean`.
   - **Fix**: Remove the `?.` operators. `return el.classList.contains(...) || ...;`

5. **XPath Generation Breaks in Shadow DOM**
   - **Location**: Lines 305-326 (`getXPath`)
   - **Problem**: When collecting blocks from a Shadow Root, `getXPath` traverses `parentElement` up to the shadow boundary, then stops. The resulting XPath is absolute to the Shadow Root, but later `findBlockNode` uses `document.evaluate` which expects XPaths relative to the main `document`.
   - **Fix**: XPaths are inherently incompatible with crossing shadow boundaries. Ensure `findBlockNode` relies purely on the `data-fanyi-block-id` attribute for shadow DOM blocks, and fallback to XPath only for the light DOM.

6. **Redundant DOM Walk for Shadow Hosts**
   - **Location**: Lines 545-570 (`collectFromShadowHosts`)
   - **Problem**: After walking the entire DOM to extract blocks, it does a *second* full TreeWalker pass purely to look for `.shadowRoot` properties. On a 10,000-node DOM, this is a massive performance penalty.
   - **Fix**: Check for `.shadowRoot` during the *first* walk inside `acceptWalkerNode` and push those hosts to an array. After the first walk finishes, iterate the array and traverse the shadow roots.


## Actionable Next Steps

If you would like me to proceed with implementing these fixes, I will:

1. **Fix `glossaryExtractor.ts`**:
   - Rewrite `isPossessive` to check all occurrences of the word.
   - Fix the plural-merge double-count logic.
   - Remove the `count < 1` dead code.
   - Update the `brandRegex` lookbehind.
2. **Fix `blockExtractor.ts`**:
   - Remove optional chaining in `hasTranslateBlockClass`.
   - Sync `acceptWalkerNode` and `grabNode` `DIRECT_SET` logic.
   - Remove the `lang` attribute check from `isInsideArticle`.
3. **Run the test suite** (`pnpm test`) to ensure no regressions are introduced. The current test suite has 458 passing tests; all fixes must keep this suite green.