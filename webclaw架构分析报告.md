# webclaw 架构分析报告

> 分析对象：`other-ref/webclaw`（Rust workspace，v0.6.x）
> 分析维度：项目定位、workspace 架构、核心抽取、抓取层、LLM 集成、服务层、设计思想

---

## 一、项目定位与核心价值

webclaw 是面向 LLM/AI Agent 的**网页内容提取工具链**，核心定位：

> Turn websites into clean markdown, JSON, and LLM-ready context.
> CLI, MCP server, REST API, and SDKs for AI agents and RAG pipelines.

解决的核心痛点：传统爬虫要么被反爬墙挡住，要么返回充斥 nav/script/ads 的原始 HTML。webclaw 把 URL 转成 LLM 可直接消费的 5 种格式：`markdown` / `json` / `text` / `llm` / `html`。

### 商业模型：open-core

- **OSS 仓库**：CLI、MCP server、自托管 REST server
- **闭源 `api.webclaw.io`**：反爬绕过、JS 渲染、异步任务、多租户等企业特性
- CLI 本地提取失败时通过 `--cloud` 或自动 fallback 走云 API

### 三种部署形态

| 形态 | 入口 | 场景 |
|---|---|---|
| CLI | `webclaw` 命令 | 单次抓取/批量/爬虫 |
| MCP server | `webclaw-mcp` (stdio) | Claude Desktop / Cursor 等 AI agent |
| REST server | `webclaw-server` (axum) | 自托管 API |

三种形态共享同一套底层提取 crate。

---

## 二、Workspace 架构

### 2.1 Crate 拆分（7 个 crate）

```
webclaw-core     纯提取引擎，零网络依赖，WASM-safe
webclaw-fetch    HTTP 客户端、爬虫、proxy、sitemap、30+ 垂直提取器
webclaw-llm      LLM provider chain（Ollama/OpenAI/Gemini/Anthropic）
webclaw-pdf      PDF 文本提取（无 OCR）
webclaw-mcp      MCP server（stdio 传输，12 个工具）
webclaw-cli      CLI 二进制
webclaw-server   axum REST API（自托管参考实现）
```

### 2.2 拆分原则：按 I/O 边界切

**最重要的硬规则**（CLAUDE.md）：

> Core has ZERO network dependencies — takes `&str` HTML, returns structured output. Keep it WASM-compatible.

- `webclaw-core` 只依赖 `scraper`/`url`，零网络，可上 WASM
- `webclaw-fetch` 独占 `wreq`（BoringSSL TLS 指纹），pin 精确版本 `=6.0.0-rc.29`
- `webclaw-llm` 用普通 `reqwest`（LLM API 不需要 TLS 指纹）
- `webclaw-pdf` 单独发布（pdf-extract 体积大，不污染其他 crate）

### 2.3 依赖关系图

```
                    webclaw-core (零网络依赖)
                   /       |        \
            webclaw-pdf  webclaw-fetch ← (wreq BoringSSL)
                          /    |    \
                  webclaw-llm  |   (reqwest, 无指纹)
                       |       |
                       └───┬───┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
       webclaw-cli    webclaw-mcp   webclaw-server
```

三个二进制 crate 互不依赖，共享底层 crate。

---

## 三、核心抽取引擎（webclaw-core）

### 3.1 抽取流水线

入口：`extract_with_options(html, url, options) -> ExtractionResult`

```
1. Reddit fast path      → old.reddit.com SSR HTML 解析
2. YouTube fast path     → ytInitialPlayerResponse 正则
3. scraper::Html::parse  → 通用 HTML 解析
4. metadata::extract     → OG/Twitter Card/meta
5. extractor::extract_content → Readability 评分
6. 三层 fallback:
   - 放宽 only_main_content
   - 用 body 选择器
   - data_island JSON 数据岛
   - QuickJS 执行内联脚本
7. domain::detect        → 域类型检测
8. structured_data       → JSON-LD / __NEXT_DATA__ / SvelteKit
```

### 3.2 评分函数

```rust
score = text_len.ln()               // 对数压缩，避免长 nav 反超
      + tag_bonus                   // article/main +50, role=main +50
      + class_id_bonus              // content/main/article 等 +25
      + p_count * 3                 // 段落密度
      - link_density_penalty;       // 链接密度惩罚
```

选择最大容器后做 `refine → expandWrappers → chooseBestRoot` 三段式精修。`chooseBestRoot` 向上扫描直到遇到含 `h1` 的祖先——与 fanyi-extension 在 claude.com 7 层嵌套下的解法一致。

### 3.3 噪声过滤（noise.rs）

三层策略：

1. **精确 token 匹配**：class 用 token 精确匹配而非子串（避免 `content-nav` 误判为 nav）
2. **短模式词边界**：≤6 字符的模式用 word-boundary 正则
3. **安全阀**：噪声类元素若 `text > 5000` 字符则不视为噪声（防误杀长 FAQ）

Cookie 同意平台通过 ID 前缀识别（onetrust/optanon/cookiebot/sp_message 等）。Tailwind 工具类通过 `UTILITY_PREFIXES`（`p-`/`m-`/`w-`/`h-`/`text-`/`bg-`）过滤。

### 3.4 LLM 优化流水线（llm/body.rs）

24+ 步管线，顺序至关重要：

```
decode_html_entities          → strip_invisible_unicode
  → strip_leaked_js           → strip_a11y_link_chrome
  → collapse_spaced_text      → convert_linked_images
  → collapse_logo_images      → strip_remaining_images
  → strip_emphasis            → strip_ui_control_text
  → strip_css_artifacts       → collapse_word_lists
  → dedup_adjacent_descriptions
  → extract_and_strip_links   → strip_bare_number_lines
  → dedup_repeated_phrases    → dedup_heading_paragraph
  → dedup_duplicate_headings  → strip_empty_headings
  → collapse_whitespace       → dedup_content_blocks
  → dedup_comma_lists         → merge_stat_lines
```

精巧的清洗子模块：
- `strip_leaked_js`：处理 `self.__wrap_n` 框架水合残留
- `collapse_spaced_text`：CSS `letter-spacing` 渲染的 "S t a r t" → "Start"
- `strip_ui_control_text`：Material Icons 连字、分页文本、箭头 Unicode
- `collapse_word_lists`：200+ 字符、20+ 词、<5% 功能词 → "... and N more"

### 3.5 特殊站点处理

**Reddit**：解析 `old.reddit.com` SSR HTML（稳定 class、无 JS、无需 API key）。评论嵌套用 blockquote 深度（`"> ".repeat(depth)`）而非空格缩进——避免 depth ≥2 时被 CommonMark 误解为缩进代码块。

**YouTube**：正则定位 `ytInitialPlayerResponse`，提取 videoDetails + microformat。还提供 caption tracks 提取和 timed text 解析（刻意不引入 XML crate）。

---

## 四、抓取层与站点适配（webclaw-fetch）

### 4.1 Fetcher trait 解耦

```rust
#[async_trait]
pub trait Fetcher: Send + Sync {
    async fn fetch(&self, url: &str) -> Result<FetchResult, FetchError>;
    fn cloud(&self) -> Option<&CloudClient> { None }
}
```

- OSS 路径：传 `&FetchClient`（wreq + BoringSSL 进程内 TLS 指纹）
- 生产路径：传 `TlsSidecarFetcher`（走 Go tls-sidecar）
- 两个路径产出的 `FetchResult` shape 完全一致，extractor 逻辑零改动

### 4.2 反爬策略

**TLS 指纹**（tls.rs）：基于 wreq + BoringSSL，逐字段匹配真实浏览器

- Chrome 133：JA3 固定 `43067709b025da334de1279a120f8e14`（匹配 bogdanfinn，过 indeed.com WAF 白名单）
- Safari iOS 26：专门为 DataDome immobiliare.it 规则 override 4 个字段（TLS extension order + HTTP/2 HEADERS priority flag）
- Firefox / Edge / Safari 各有独立 profile

**关键设计**：HTTP/2 HEADERS 帧的 `StreamDependency` priority flag 才是 DataDome 真正校验的字段——这是花钱买来的经验。

**云端升级**（cloud.rs）：

```
L0: fetch           → 普通页面（wreq HTTP + TLS 指纹）
L1: fetch_smart     → Reddit/Akamai 挑战（URL 重写 + cookie warm）
L2: fetch_and_extract → PDF/Office/LinkedIn（Content-Type 路由）
L3: smart_fetch_html → 检测到 bot 防护（升级到 api.webclaw.io）
L4: smart_fetch     → L3 + 检测到 SPA（再升级 + cloud markdown）
```

`is_bot_protected` 检测 Cloudflare（`_cf_chl_opt`/Turnstile/`just a moment`）、DataDome、AWS WAF、hCaptcha。

**synthesize_html** 桥接：云端返回结构化数据，本地重组为最小 HTML（meta tags + JSON-LD + markdown in `<pre>`），让 HTML-based extractor 零改动跑云输出。

### 4.3 Extractor 插件机制

**注册**：match 链而非 trait registry（~30 个 extractor，注释说 50+ 才考虑 trait registry）

每个 extractor 三件套：
- `pub const INFO: ExtractorInfo` — name/label/url_patterns
- `pub fn matches(url: &str) -> bool`
- `pub async fn extract(client: &dyn Fetcher, url: &str) -> Result<Value, FetchError>`

**两种分发**：
- `dispatch_by_url`：auto-detect（部分宽匹配的 extractor 故意不放，如 shopify_product/substack_post）
- `dispatch_by_name`：explicit（调用者指定 vertical）

**四层 fallback**：每个 extractor 内部都有 JSON-LD → DOM regex → OG meta → 通用抽取的降级链，返回 `data_source` 字段告知数据来源。

### 4.4 SSRF 防护（三层）

1. **URL 解析**：`validate_public_http_url` 拒绝私有/内网 IP
2. **DNS 解析过滤**：`PublicDnsResolver` 在 wreq DNS 阶段再过滤（防 DNS rebinding）
3. **重定向再校验**：`ssrf_safe_redirect_policy` 每次 302 都重新 validate

覆盖 IPv4（private/loopback/link-local/CGN/multicast）和 IPv6（ULA/link-local/NAT64/文档/嵌入 IPv4）。

### 4.5 爬虫策略

- BFS + `Semaphore` 并发控制
- Scope：same-origin / allow_subdomains / allow_external_links
- Frontier 容量防护：`frontier_cap = max_pages × 10`，超过则 truncate
- ReDoS 防护：`MAX_GLOB_LEN=1024`、`MAX_GLOB_DOUBLESTAR=4`
- 可取消（`AtomicBool`）+ 可恢复（`CrawlState` 序列化）+ 可流式（`broadcast::Sender`）
- Sitemap 集成：crawl 前先 `sitemap::discover` 把 URL 加到 depth=0 frontier

---

## 五、LLM 集成（webclaw-llm）

### 5.1 Provider 抽象

```rust
#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn complete(&self, request: &CompletionRequest) -> Result<String, LlmError>;
    async fn is_available(&self) -> bool;
    fn name(&self) -> &str;
}
```

四个 Provider 实现差异：

| Provider | 鉴权 | JSON 模式 | 默认模型 |
|---|---|---|---|
| Ollama | 无（本地） | `format: "json"` | `qwen3:8b` |
| OpenAI | Bearer | `response_format` 三档 | `gpt-4o-mini` |
| Anthropic | x-api-key | 无原生（靠 prompt） | `claude-sonnet-4-6` |
| Gemini | x-goog-api-key | `responseMimeType` | `gemini-2.5-flash` |

### 5.2 ProviderChain 装饰器

**ProviderChain 自身也实现 `LlmProvider`**，链和单 provider 在调用方眼中无差别：

```rust
impl LlmProvider for ProviderChain {
    async fn complete(&self, request: &CompletionRequest) -> Result<String, LlmError> {
        for provider in &self.providers {
            match provider.complete(request).await {
                Ok(response) => return Ok(response),
                Err(e) => { errors.push(format!("{}: {e}", provider.name())); }
            }
        }
        Err(LlmError::AllProvidersFailed(errors.join("; ")))
    }
}
```

**默认链顺序**（local-first）：
1. Ollama（本地优先，免费、隐私）
2. OpenAI
3. Gemini（Google Cloud credits 优先于 Anthropic）
4. Anthropic（最后兜底）

### 5.3 思考标签清洗

`strip_thinking_tags` 处理 qwen3 等模型的 `<think>...</think>` 标签。extract.rs 和 summarize.rs 在解析前**再次**调用此函数（"defense in depth"）。

### 5.4 Prompt 设计

- **角色设定明确**："You are a X engine"
- **强约束输出**："ONLY valid JSON"、"No explanations, no markdown"
- **温度分层**：抽取=0.0（确定），摘要=0.3（略创造）
- **system + user 双消息**：指令在 system，内容在 user

---

## 六、HTTP Server（webclaw-server）

### 6.1 设计原则

> This is the OSS reference server. It is intentionally small: single binary, stateless, no database, no job queue.

- Axum 0.8，无状态、无 DB、无 job queue
- 10 个 POST 路由 + 2 个 GET
- 硬上限：crawl ≤500 页、batch ≤100 URL、并发 ≤20

### 6.2 路由表

| Method | Path | 功能 |
|---|---|---|
| GET | `/health` | 健康检查（无鉴权） |
| POST | `/v1/scrape` | 单页抓取（5 种格式） |
| POST | `/v1/scrape/{vertical}` | 垂直抽取器 |
| POST | `/v1/crawl` | BFS 爬取 |
| POST | `/v1/map` | sitemap URL 发现 |
| POST | `/v1/search` | Serper.dev 搜索 |
| POST | `/v1/batch` | 并行批量 |
| POST | `/v1/extract` | LLM 结构化抽取 |
| POST | `/v1/summarize` | LLM 摘要 |
| POST | `/v1/diff` | 内容差异对比 |
| POST | `/v1/brand` | 品牌识别（无 LLM） |
| GET | `/v1/extractors` | 列出垂直抽取器 |

### 6.3 安全设计

- **Bearer token 常量时间比较**（`subtle::ConstantTimeEq`）防时序攻击
- **拒绝 0.0.0.0 无鉴权绑定**（除非显式 `WEBCLAW_ALLOW_OPEN_PUBLIC`）
- **入站/出站凭证分离**：`WEBCLAW_API_KEY`（入站）vs `WEBCLAW_CLOUD_API_KEY`（出站）

### 6.4 错误处理

```rust
enum ApiError {
    BadRequest(String),         // 400
    Unauthorized,               // 401
    NotFound,                   // 404
    Fetch(String),              // 502 (upstream)
    Extract(String),            // 422
    Llm(String),                // 422
    Internal(String),           // 500
    NotImplemented(String),     // 501 (部署配置缺失)
}
```

`NotImplemented` 区分"部署配置缺失"（501）与"服务端错误"（500）。

---

## 七、MCP Server（webclaw-mcp）

### 7.1 设计

- 基于 `rmcp` crate，stdio transport
- 日志走 stderr（stdout 是 MCP 传输通道）
- 12 个 tools：scrape/crawl/map/batch/extract/summarize/diff/brand/research/search/list_extractors/vertical_scrape

### 7.2 关键设计

**三个客户端的差异化缓存**：
- Chrome 客户端：复用 `fetch_client`
- Firefox 客户端：`OnceLock` 懒构建（Reddit 封 Chrome TLS 指纹时用）
- Random：每次构建（指纹轮换）

**LLM chain 启动时构造一次**（与 server 的 per-request 构造不同）。

**容错设计**：处理 MCP 客户端的"数字传成字符串"问题（`deser_opt_u32_or_str`），应对不同 MCP 客户端的序列化差异。

**Research 工具**：唯一需要 cloud 的异步 job，轮询 ~10min，结果落盘 `~/.webclaw/research/` + 缓存。slugify 是 char-safe 的（CJK 多字节字符不会 panic）。

---

## 八、设计思想总结

### 8.1 核心模式

1. **按 I/O 边界切 crate** — core 零网络可上 WASM，fetch 独占 wreq 指纹栈，llm 独立 reqwest
2. **Trait 抽象解耦** — Fetcher trait 让 OSS 和生产 server 用不同 TLS 后端但共享提取器；LlmProvider trait + ProviderChain 装饰器让本地/云端 LLM 透明切换
3. **Local-first + 云端兜底** — LLM 链 Ollama 优先，抓取本地优先遇反爬才走 cloud
4. **多层安全阀** — 噪声类 >5000 字符豁免、`MAX_DOM_DEPTH=200`、`MAX_SCAN_BYTES=8MB`、PDF 50MB 上限
5. **精确匹配优先于子串** — class token 精确匹配、cookie 平台 ID 前缀匹配
6. **防御性编程** — SSRF 三层防护、响应体 5MB 封顶、Gemini model name 路径注入防御、bearer 常量时间比较
7. **明确区分 OSS vs Hosted** — server 注释反复强调"stateless, no DB, no job queue"
8. **BYO-key 哲学** — search 用操作者自己的 Serper key，LLM 用操作者自己的 OpenAI/Anthropic key

### 8.2 工程化亮点

- **注释解释"为什么"而非"是什么"** — 每个设计决策都有注释说明动机
- **测试覆盖充分** — 含真实 bug 回归测试（qwen3 `/think` 泄漏、CJK slugify panic、Express.co.uk 栈溢出）
- **基准测试双轨** — CLI 微基准（近似 tokenizer）+ 完整跨工具对比（真实 tiktoken）
- **facts.json 社区可维护** — 基准数据是 commit 的数据资产，可 PR 添加

### 8.3 与 fanyi-extension 的共鸣

webclaw-core 的多个设计与 fanyi-extension 踩过的坑高度一致：

| 问题 | webclaw 解法 | fanyi-extension 解法 |
|---|---|---|
| claude.com 7 层嵌套根节点 | chooseBestRoot 向上扫到 h1 | chooseBestRoot 向上扫到 h1 |
| cookie modal 误判 | ID 前缀匹配 + textContent 安全阀 | isConsentSdkContainer 匹配 plain "cookie" |
| Tailwind class 误匹配 | UTILITY_PREFIXES 过滤 | tokenizeClass 排除 `:` 和 `[` |
| LLM 输出 ```json 包裹 | stripMarkdownCodeBlock | stripMarkdownCodeBlock |
| 模型截断 JSON | repairTruncatedJson | repairTruncatedJson |

说明这些问题具有跨实现的普遍性，webclaw 的解法值得借鉴。

---

## 关键文件路径

```
other-ref/webclaw/
├── CLAUDE.md                          # 架构权威文档
├── Cargo.toml                         # workspace 根
├── benchmarks/
│   ├── methodology.md                 # 基准方法论
│   └── facts.json                     # 18 站点 90 facts
└── crates/
    ├── webclaw-core/src/
    │   ├── lib.rs                     # 提取流水线入口
    │   ├── extractor.rs               # Readability 评分
    │   ├── noise.rs                   # 噪声过滤
    │   ├── markdown.rs                # HTML→markdown
    │   ├── types.rs                   # 核心类型
    │   ├── llm/body.rs                # 24 步 LLM 清洗
    │   ├── llm/cleanup.rs             # 清洗子模块
    │   ├── reddit.rs                  # Reddit 特殊处理
    │   └── youtube.rs                 # YouTube 特殊处理
    ├── webclaw-fetch/src/
    │   ├── fetcher.rs                 # Fetcher trait
    │   ├── client.rs                  # FetchClient
    │   ├── tls.rs                     # TLS 指纹
    │   ├── cloud.rs                   # 云端升级
    │   ├── url_security.rs            # SSRF 防护
    │   ├── crawler.rs                 # 爬虫
    │   └── extractors/                # 30+ 垂直提取器
    ├── webclaw-llm/src/
    │   ├── provider.rs                # LlmProvider trait
    │   ├── chain.rs                   # ProviderChain 装饰器
    │   └── providers/                 # 4 个 provider
    ├── webclaw-server/src/
    │   ├── main.rs                    # server 入口
    │   ├── state.rs                   # 状态管理
    │   ├── auth.rs                    # 认证
    │   └── routes/                    # 10+ 路由
    └── webclaw-mcp/src/
        ├── main.rs                    # MCP 入口
        ├── server.rs                  # MCP server
        └── tools.rs                   # 12 个 tools
```
