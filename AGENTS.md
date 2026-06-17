# Fanyi Extension — Agent Guide

## Commands (run in order when fixing issues)

```sh
pnpm compile        # typecheck (vue-tsc --noEmit) — run first
pnpm test           # vitest run (jsdom env)
pnpm build          # build Chrome — also triggers pre-build type checks
pnpm build:firefox  # build Firefox (manifest v2)
pnpm dev            # Chrome dev mode with HMR
pnpm dev:firefox    # Firefox dev mode
pnpm zip            # package Chrome
```

`pnpm compile` must pass before building. `pnpm test` does type inference but no typecheck.

## Architecture

WXT extension with entrypoints at `src/entrypoints/`:
- `background.ts` — orchestrates translation via DeepSeek API, manages cache, handles messages
- `content.ts` — injected on all pages, extracts DOM blocks, applies translations inline
- `content/serverTranslation.ts` — sends pre-marked HTML to `/fanyi/page` server endpoint and applies bilingual translations from the returned HTML
- `popup/` — Vue 3 app for config UI
- `service/deepseek.ts` — API client (hardcoded model `deepseek-v4-flash`, endpoint `api.deepseek.com/v1/chat/completions`)
- `utils/blockExtractor.ts` — walks DOM with TreeWalker, returns `TextBlock[]`
- `utils/chunkBuilder.ts` — groups blocks into chunks
- `utils/config.ts` — `@wxt-dev/storage` at key `local:config`

## Server translation mode

When `config.useServerTranslation` is enabled, the extension skips the local DeepSeek API and instead sends the page HTML (with `data-fanyi-block-id` attributes set by the walker) to a configured `/fanyi/page` endpoint. The server returns a bilingual HTML response; the extension extracts `.fanyi-translation` text for each marked block and applies it via `applyBlockTranslation()`. This mode does not require a local API key.

Key files for server mode:
- `src/entrypoints/content/serverTranslation.ts` — `translateViaServer()` implementation
- `src/entrypoints/utils/config.ts` — `useServerTranslation` and `serverUrl` config fields
- `src/entrypoints/popup/App.vue` and `src/entrypoints/content/configPanel.ts` — UI switches and URL input
- `fanyi-extension-blocks-protocol.md` — protocol between extension and server

`src/rules/` — site-specific translation rules (GitHub, Reddit, HackerNews). Add files there and register in `index.ts`.

`src/components/` — Vue 3 components (FloatingBall, SelectionTranslator, TranslationStatus).

## Build output

- `output/chrome-mv3/` — Chrome (manifest v3, supports keyboard shortcuts `Alt+T`/`Alt+R`/`Alt+V`)
- `output/firefox-mv2/` — Firefox (no `contextMenus` or `commands` support; touch gestures instead)

A build hook (`wxt.config.ts:63`) rewrites absolute asset paths in HTML to relative paths for both targets.

## Tests

- Vitest + jsdom environment (`--globals` enabled)
- `src/entrypoints/utils/blockExtractor.test.ts` tests DOM extraction against real HTML fixtures
- Tests use `document.body.innerHTML = ...` setup before each case

## Key gotchas

- `postinstall` runs `wxt prepare` (auto-generates `.wxt/` types). Run `pnpm install` after pulling if `.wxt/` is stale.
- Content script builds a floating button directly (no polyfill for content) and communicates with background via `browser.runtime.sendMessage`.
- Chrome stores keyboard shortcuts in manifest. Firefox ignores them — add shortcuts through `about:addons`.
- TreeWalker `currentNode` must NOT be set manually — real Chrome/Firefox behave differently from jsdom (see `blockExtractor.ts:375` comment).
- Translation cache uses simple string hash (not cryptographic) with 7-day TTL.
- Config writing uses `JSON.parse(JSON.stringify(...))` to strip Proxy wrappers from Vue refs.
- Chunks process **serially (concurrency=1)** on both desktop and mobile. The DeepSeek prompt cache (KV cache) only hits from the second request onward when requests share a prefix and are dispatched sequentially — parallel 4-way dispatch all-misses the cache. Serial mode lets every chunk benefit from the prior chunk's cache (`prompt_cache_hit_tokens` returns to 80%+). Per-chunk retry, global retry, and DOM application (`applyTranslationsWithRAF`) all stay as documented.
