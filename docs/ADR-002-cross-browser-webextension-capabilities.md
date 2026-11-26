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
