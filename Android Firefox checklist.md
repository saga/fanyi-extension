可以直接把下面这个 checklist 发给 coding agent 做系统性排查。

---

# Firefox Android + Vue3 + WXT Extension Compatibility Checklist

## 1. Storage API 是否写入了 Proxy/reactive 对象

检查：

```ts
browser.storage.local.set(...)
browser.storage.sync.set(...)
chrome.storage.local.set(...)
```

禁止：

```ts
set({
  data: reactiveObj
})
```

修复：

```ts
set({
  data: JSON.parse(JSON.stringify(data))
})
```

或：

```ts
set({
  data: structuredClone(toRaw(data))
})
```

---

## 2. runtime.sendMessage 是否传递了 reactive/ref

检查：

```ts
browser.runtime.sendMessage(...)
tabs.sendMessage(...)
port.postMessage(...)
```

禁止：

```ts
sendMessage({
  state: reactiveState
})
```

修复：

```ts
sendMessage(
  JSON.parse(JSON.stringify(payload))
)
```

---

## 3. background/content/popup 之间 message 是否包含：

* Proxy
* ref
* computed
* class instance
* function
* Symbol
* DOM object

Firefox structured clone 更严格。

---

## 4. Pinia store 是否直接持久化

危险：

```ts
storage.set({
  store: piniaStore
})
```

正确：

```ts
storage.set({
  store: storeToRefs(...)
})
```

或者：

```ts
storage.set({
  store: JSON.parse(JSON.stringify(store.$state))
})
```

---

## 5. 是否直接存储 Vue component instance

禁止：

```ts
storage.set({
  vm: getCurrentInstance()
})
```

---

## 6. 是否依赖 Chrome 宽松行为

检查代码中：

```ts
chrome.*
```

与：

```ts
browser.*
```

混用情况。

Firefox Android：

* 更严格
* Promise 化行为不同
* callback timing 不同

---

## 7. 是否使用了 unsupported MV3 APIs

Firefox Android 对 MV3 支持不完整。

重点检查：

* offscreen document
* sidePanel
* declarativeNetRequest
* service worker lifecycle
* scripting API
* action API

建议查：

```json
manifest_version
```

以及：

```json
"browser_specific_settings"
```

---

## 8. service worker 生命周期假设

Chrome：

* worker 常驻更久

Firefox：

* 更容易 suspend

检查：

* 内存状态是否丢失
* singleton 是否失效
* in-memory cache 是否可靠

不要假设：

```ts
globalThis.xxx
```

永远存在。

---

## 9. 是否依赖 window/localStorage

background/service worker 中：

```ts
window
localStorage
document
```

可能不存在。

Firefox Android 更容易暴露问题。

---

## 10. content script 是否访问了页面 JS 对象

Firefox 隔离更严格。

检查：

```ts
window.someGlobal
```

是否真的可访问。

可能需要：

```ts
injected script
```

桥接。

---

## 11. structuredClone compatibility

检查对象是否包含：

* Map
* Set
* Date
* RegExp
* Error
* BigInt

不同浏览器行为不同。

最稳：

```ts
JSON serialize
```

---

## 12. 是否依赖 Chrome extension polyfill bug/特性

检查：

```ts
webextension-polyfill
```

版本。

旧版本在 Firefox Android 问题很多。

---

## 13. async race conditions

Firefox Android：

* extension startup 更慢
* storage init 更慢

检查：

```ts
await init()
```

是否真的 await。

---

## 14. popup 生命周期假设

Firefox Android popup：

* 更容易销毁
* 切后台即关闭

不要把状态只存在 popup memory。

---

## 15. 是否使用 DOM API 于 background

禁止：

```ts
document.createElement
```

除非确认：

* background page
* 非 service worker

---

## 16. CSP 差异

Firefox 对：

* eval
* new Function
* inline script

更严格。

检查：

* dynamic import
* WASM
* injected code

---

## 17. WXT auto-import/runtime assumptions

检查：

* auto-import 是否引入 browser-only API
* SSR-like 环境是否误执行

---

## 18. Firefox Android UI capability

很多 desktop Firefox API：

Android 不支持。

例如：

* sidebar
* devtools
* contextMenus 部分能力
* downloads API 某些功能

---

## 19. Manifest permissions 差异

检查：

```json
host_permissions
permissions
optional_permissions
```

Firefox Android 对权限处理不同。

---

## 20. JSON serialization audit（最重要）

全局搜索：

```ts
storage.set
sendMessage
postMessage
emit
broadcast
```

确认所有跨上下文数据都经过：

```ts
sanitize()
```

建议统一：

```ts
export function sanitize<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}
```

然后：

```ts
sendMessage(sanitize(data))
storage.set(sanitize(data))
```

---

# 推荐最终策略（最稳）

## Extension 内部约定：

跨边界数据必须：

* plain object
* JSON serializable
* 无 Proxy
* 无 class instance
* 无 function
* 无 DOM object

---

## 建议建立统一层

```ts
export function safeClone<T>(data: T): T {
  return JSON.parse(JSON.stringify(data))
}
```

统一用于：

* storage
* message passing
* cache persistence
* background ↔ popup
* content ↔ background

---

# 最后重点排查（80%问题来源）

Firefox Android extension 出问题时：

优先检查：

1. Proxy/reactive
2. structured clone
3. service worker lifecycle
4. unsupported MV3 API
5. async startup race
6. popup state persistence

通常就是这里。
