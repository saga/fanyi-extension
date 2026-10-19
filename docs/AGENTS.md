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

`pnpm compile` is available for diagnostics, but it currently reports substantial pre-existing type errors across both source and test files, so it is intentionally not a blocking CI step. CI blocks on unit tests and production builds for both Chrome and Firefox. Do not describe the project as type-clean until `pnpm compile` is fixed and re-enabled.

## Architecture

WXT extension with entrypoints at `src/entrypoints/`:
- `background.ts` — routes remote and local translation requests, validates translation results, manages browser/SQLite cache, handles messages
- `content.ts` — injected on all pages, extracts DOM blocks, applies translations inline
- `content/serverTranslation.ts` — sends pre-marked HTML to `/fanyi/page` server endpoint and applies bilingual translations from the returned HTML
- `popup/` — Vue 3 app for config UI
- `service/deepseek.ts` — shared translation client; uses DeepSeek remotely or the configured OpenAI-compatible loopback endpoint for the local Agent Provider
- `utils/blockExtractor.ts` — walks DOM with TreeWalker, returns `TextBlock[]`
- `utils/chunkBuilder.ts` — groups blocks into chunks
- `utils/config.ts` — `@wxt-dev/storage` at key `local:config`

## Server translation mode

When `config.useServerTranslation` is enabled, the extension sends the page HTML (with `data-fanyi-block-id` attributes set by the walker) to a configured `/fanyi/page` endpoint. The endpoint only supports `mode='bilingual'` and `service='deepseek'`, and requires the extension to provide a DeepSeek API Key (`config.deepseekApiKey`) in the request body. The server uses this client-provided key to call DeepSeek, then returns a bilingual HTML response. The extension extracts `.fanyi-translation` text for each marked block and applies it via `applyBlockTranslation()`.

Key files for server mode:
- `src/entrypoints/content/serverTranslation.ts` — `translateViaServer()` implementation
- `src/entrypoints/utils/config.ts` — `useServerTranslation`, `serverUrl`, and `deepseekApiKey` config fields
- `src/entrypoints/popup/App.vue` and `src/entrypoints/content/configPanel.ts` — UI switches and URL input
- `fanyi-extension-blocks-protocol.md` — protocol between extension and server

`src/rules/` — site-specific translation rules (GitHub, Reddit, HackerNews). Add files there and register in `index.ts`.

`src/components/` — Vue 3 components (FloatingBall, SelectionTranslator, TranslationStatus).

## Local Agent Provider

`config.useLocalAgent` has priority over `config.useServerTranslation`. When enabled, webpage/chunk translation, document chunk translation, side-panel chat, YouTube subtitles, and EPUB/PDF literary analysis/review must use the configured local Agent endpoint. A local request failure is an error or a retained-draft warning; do not retry it through the remote Vocal Saga/DeepSeek endpoint. The optional `localAgentToken` is sent only when configured. SQLite cache read/write failures are cache misses, but clearing the SQLite cache must report a failed request instead of claiming complete success.

The Express + TypeScript service lives in the sibling `devweekly/vocal-saga/local-agent-service` directory. It binds to loopback and uses SQLite for translation cache, request history, and a document recovery snapshot. IndexedDB remains the extension's primary document store; SQLite's serialized document checkpoint is limited to 5 MiB, so it is not a guaranteed backup for every file the reader can open. Do not describe this copy as unlimited or replace IndexedDB with it.

## Document project state authority

Follow [ADR-002: Local Agent 项目状态以服务端为权威](ADR-002-server-authoritative-document-state.md) and the paired Vocal Saga [ADR-0003](https://github.com/devweekly/vocal-saga/blob/main/docs/adr/0003-server-authoritative-project-state.md).

- Local Agent SQLite is authoritative for an existing document project's source revision, accepted translations/manual edits, Prompt revision, literary memory, Context Graph, runs, and events.
- Context Graph, source evidence, chapter summaries and full-book analysis stay in the Local Agent service. The extension must never merge graph nodes/evidence into LiteraryMemory or download the full graph during status polling; use GET /api/documents/projects/:id/context-graph/status for UI state.
- The Local Agent Run worker owns the literary preprocessing gate (source revision, analysis version, language direction, auto-start/wait/failure). The extension submits the Run and displays persisted status; it must not maintain a second normal-path preprocessing workflow. Any analysis fallback must be explicitly limited to remote-only mode when Local Agent is unavailable, not treated as canonical project state.
- Extension project-ID maps are caches. If missing or stale, resolve the document through `POST /api/documents/projects/resolve`; do not automatically create duplicate projects after network/authentication errors.
- On open/restore, hydrate from the service before persisting the local snapshot. Existing projects must not receive cached extension translations, Prompt, or literary memory merely because a session was restored.
- Exact source fingerprint match allows hydration. Same-name/title but changed-source projects require explicit source-revision update or a separate project; never apply old accepted translations to changed source text.
- IndexedDB and the local session checkpoint are offline recovery copies only. When the service is unavailable, preserve the last local copy and tell the user it may be stale. When the service returns, resolve and refresh from it.
- Run creation should use the project's persisted Prompt; only explicit settings actions may save a new Prompt revision. Tests should cover lost/stale maps, offline behavior and server-over-cache precedence.

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
- The content script schedules two warm-up chunks, then allows up to 4 (desktop) / 2 (mobile) chunk tasks in flight. However, `background.ts` sends model requests through `globalQueue`, whose current concurrency is 1. This means scheduling is concurrent but actual model calls are globally serialized. Keep these two layers distinct when changing concurrency or reasoning about provider prompt-cache behavior; chunk retry, missing-ID validation, and DOM application (`applyTranslationsWithRAF`) are separate concerns.
