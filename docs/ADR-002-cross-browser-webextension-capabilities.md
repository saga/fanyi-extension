# ADR-002: Cross-browser WebExtension capability layer

- Status: Accepted
- Date: 2026-11-27

## Decision

Use a capability adapter and browser-specific implementations. Detect actual runtime APIs; do not infer full support from browser family alone.

| Capability | Firefox desktop | Firefox Android | Chrome desktop | Chrome Android |
|---|---|---|---|---|
| DOM modification | Content Scripts / scripting | Content Scripts / scripting, restricted pages excluded | Content Scripts / scripting | Ordinary desktop extensions unavailable |
| Main-world script | Version-dependent injection; Firefox page-object bridge is Firefox-only | Version-dependent; verify runtime | scripting MAIN world | Not available |
| Non-active tabs | tabs APIs + host permission | tabs APIs, Android lifecycle/UI limits | tabs APIs + host permission | Not available |
| Network metadata | webRequest | webRequest | webRequest / CDP | Not available |
| Network response body | filterResponseData + webRequestBlocking | Firefox filterResponseData, opt-in and bounded | CDP Network.getResponseBody | Not available |
| WebAuthn RP-ID override | Firefox 150+ | Verify actual Android release/runtime | Chrome 122+ | Not available |
| Contextual identities | Firefox desktop; permission and feature enabled | Do not assume available | No native equivalent | Not available |
| wrappedJSObject / exportFunction | Firefox-only, security-sensitive | Firefox-only, security-sensitive | Not available | Not available |

## Implementation rules

1. Modify pages through content scripts or scripting APIs. Insert remote text with DOM APIs and textContent; never interpolate untrusted strings into innerHTML.
2. Treat MAIN-world code and page DOM as hostile. Do not expose privileged extension objects, secrets, or unrestricted message handlers.
3. Script execution is only invoked by explicit extension UI. Never pass page content, remote text, or model output directly to an evaluator.
4. Explicit tabId wins. Non-active tab operations require host permission; activeTab is limited to a user-requested active tab.
5. WebAuthn runs in an extension document, not the background worker. Host permissions must cover the RP ID; the relying party must validate the extension origin.
6. Contextual Identities is an optional Firefox-only enhancement. Continue normally when absent or disabled; never emulate containers by copying cookies.
7. Mobile support means capability detection and graceful fallback, not pretending desktop-only browser APIs exist.
8. Network capture is explicit, per-tab, bounded, and redacts credential headers and sensitive URL parameters.


## Agent tool integration

The webpage chat uses a narrow, structured tool protocol. Model output can request only a declared tool and JSON arguments; the extension validates each request and presents a confirmation card before execution.

- Page tools are fixed DOM operations (inspect visible text, find/highlight text, scroll, click a button/link). They use the browser's default isolated world; omit the `world` property so supported Firefox 109-127 versions do not receive a newer option. They never evaluate model-authored JavaScript. Inspection filters hidden DOM, form controls and editable regions, and bounds the text-node scan.
- A click request first runs a read-only preview and shows the actual control label and link URL in the confirmation card. The click executes only after approval and rechecks the page URL and target metadata in the injected function to reduce navigation/DOM time-of-check-to-time-of-use races. The action uses a synthetic DOM click, not trusted physical input; sites that require a real user gesture may reject it.
- Every tool call requires an explicit user approval. The source tab ID is selected by the extension, not by the model. High-impact actions such as payment, deletion, sending or authorization are not exposed as generic click operations.
- Firefox container listing requests the optional `contextualIdentities` permission. Opening a tab in a container also requests `cookies`, because a container tab can read and modify that container's cookies. Both permissions remain optional and are requested as the first asynchronous operation inside the approval-click handler; do not await a permission preflight first.
- Passkey create/get runs from the extension document so the browser can retain user activation. The credential API is invoked synchronously from the approval-click call stack before any awaited permission preflight. The relying party's server-generated options must include a valid RP ID and challenge; the model is instructed never to invent these values. Credential response JSON is displayed locally for the user and is not fed back into model context. The relying-party server remains responsible for verifying the challenge, extension origin, RP ID, signature and attestation/assertion.
- Tool output is untrusted data. It is added to the next model turn as data, never as system instructions. A single chat turn is limited to three tool calls.


## Review hardening

- The Agent page-action adapter omits `scripting.executeScript.world` and relies on the API's default isolated world for compatibility with the declared Firefox 109 minimum.
- The page-action function validates the expected URL again in the page context. A changed URL, hidden element, editable region, or click target that differs from the preview aborts the operation.
- Click previews are read-only and display the actual target label and absolute href before enabling approval. High-impact submit actions and known sensitive navigation paths remain blocked.
- Page-text extraction skips hidden/aria-hidden/inert nodes and user-editable regions, and caps DOM traversal.
- Container permissions are requested directly from the approval handler. Passkey create/get no longer awaits `permissions.contains()` before starting `navigator.credentials.create/get`, preserving transient user activation. Browser-side host-permission enforcement remains authoritative.


- Privileged `chat` and `network-inspector` runtime ports accept connections only from this extension's own `sidepanel.html` document. The guard compares protocol, extension ID (URL host), and path; it does not rely on the generic URL `origin` value for extension schemes.
- While a tool confirmation is pending, the sidepanel sends a low-frequency heartbeat over the existing port. It stops on approval, rejection, completion, disconnect, or unmount so a long user review does not leave a stale request due to MV3 worker suspension.
- Explicit source tab IDs are strict: a closed, restricted, or stale tab fails closed instead of silently falling back to another active tab. A container-open result explicitly switches the current chat to the newly-created tab without restoring unrelated tab history into the in-flight turn.
- Tool-request JSON remains buffered in the streaming API backend until the final response is parsed, including JSON mode; structured call arguments are not briefly rendered as ordinary chat text.
