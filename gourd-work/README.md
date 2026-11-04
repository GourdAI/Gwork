# gourd-work

GWork 的 **Rust 原生智能体内核** —— Java 内核（`gourdai-java/gourd-ai-agent`）的完整重写，目标：

- **性能**：无 JVM 启动开销，无「壳 → 子进程 → HTTP 代理」的多跳损耗
- **鸿蒙 PC**：不依赖 JDK，可原生编译
- **可嵌入**：内核进程内嵌于 Tauri 桌面壳，不再拉起 Java 子进程

> **2026-10-26 起本模块是仓库主目录与唯一维护线。**
> 四个 Java 模块（gourd-ai-agent / gourd-ai-desktop / gourd-ai-tauri / gourd-ai-website）
> 已整体迁入 `gourdai-java/` 并**冻结**，仅保留用于对照与既有用户升级链，不再接受新功能。
> 前端 UI 也已迁入本模块 `desktop/ui/` 并**入库维护**（详见下文「前端 UI」）。

## 目录结构

```
gourd-work/
├── core/              # 智能体内核（library crate）
│   └── src/
│       ├── config/        # settings.json 兼容加载（零迁移读 ~/.gwork/）
│       ├── llm/           # OpenAI 兼容流式客户端（SSE + 重试退避）
│       ├── protocol/      # WS 帧协议（与现有前端逐字兼容）
│       ├── tools/         # 工具注册表 + 24 个内置工具
│       ├── react/         # ReAct 循环 + 中英系统提示词
│       ├── session/       # 会话持久化（ndjson + .stream.ndjson 回放）
│       ├── memory/        # 长期记忆
│       ├── skills/        # 技能发现（SKILL.md）
│       ├── mcp/           # Model Context Protocol 客户端（stdio）
│       ├── team/          # 子代理编排
│       ├── server/        # HTTP + WS 服务（/web/chat/* + /web/gate）
│       ├── changes.rs     # 文件变更账本（内容寻址 blob + 每 run manifest）
│       ├── loop_task.rs   # 定时任务（cron + interval）
│       ├── attachments.rs # 附件上传与文本注入
│       ├── ephemeral.rs   # 临时产物过滤
│       ├── acp.rs         # ACP 协议（stdio JSON-RPC agent）
│       └── ...            # channels / projects / filer / gitops / queue / terminal / usage
├── cli/               # 终端前端（二进制名 gwork）
└── desktop/           # Tauri 桌面壳（内核进程内嵌，无 JVM）
    ├── src-tauri/         # Rust 壳 + tauri.conf.json
    ├── ui/                # ★ 产品级前端唯一源（入库维护，203 文件）
    ├── ui-demo/           # 迁移前的 6 文件极简演示页（留存备查）
    └── package.json       # 钉版 @tauri-apps/cli
```

## 前端 UI

`desktop/ui/` 是**入库维护的唯一源**，不是构建期拷贝产物：

- 203 文件 / 约 22 MB，2026-10-26 从 `gourd-ai-agent/src/main/resources/static` 实体迁入，
  逐文件 SHA-256 校验零丢失
- 含 monaco 编辑器（114 文件）、**12 个语言包**（de/el/en/es/fr/ja/pt/ro/ru/vi/zh-CN/zh-TW，
  各 1238 个叶子键）、10 个 HTML 入口页
  （index / chat / code / settings / model-settings / skills / memory / usage / automation / channel）
- 由 `tauri.conf.json` 的 `frontendDist: "../ui"` 直接内联进安装包，**构建期零拷贝**
- CI 有「UI 完整性门禁」：文件数 ≥200、语言包 =12、HTML 入口页 =10、各语言包键数一致，
  任一不满足即红 —— 防止误加 `/ui/` 到 `.gitignore` 或误删语言包导致「打包成功但界面是坏的」

> 不要照抄 `gourdai-java/gourd-ai-tauri/.gitignore` 里的 `/ui/` 规则：那边的 `ui/` 是
> `prepare-ui.js` 的拷贝产物，这边的 `ui/` 是源码，忽略掉等于把整个前端删出仓库。

## 构建

```bash
# 全量检查
cargo check --workspace

# 测试
cargo test --workspace

# CLI 二进制 → target/release/gwork.exe（约 5 MB）
cargo build --release -p gourd-work-cli

# 交互式 REPL
cargo run -p gourd-work-cli

# 作为 HTTP/WS 服务启动（供 Web UI 连接）
cargo run -p gourd-work-cli -- --serve 8080
# 附带静态 UI 目录
cargo run -p gourd-work-cli -- --serve 8080 --static desktop/ui
```

### 桌面安装包

```bash
cd desktop
npm install              # 装钉版的 @tauri-apps/cli 2.12.0
npm run build:win        # Windows nsis
npm run build:mac        # macOS app + dmg
npm run build:linux:deb  # Linux deb
npm run build:linux:appimage
```

> **产物路径注意**：`gourd-work` 是 Cargo **workspace**，`target/` 在 workspace 根，
> 所以产物落在 `gourd-work/target/release/bundle/nsis/`，
> **不是** `desktop/src-tauri/target/`（后者不存在）。
> 这与 `gourdai-java/gourd-ai-tauri` 不同 —— 那边的 `src-tauri` 不属于任何 workspace。
> 2026-10-26 Windows 实测：`GWork_0.3.0_x64-setup.exe` 7.75 MB，耗时约 3 分钟。

CI 见 `.github/workflows/build-gourd-work.yml`（三平台桌面安装包 + 内核/CLI 门禁，
不需要 JDK/Maven/jlink）。

## 兼容性

- 读同一份 `~/.gwork/settings.json`（支持 models 的 map / array 双格式）
- 会话数据沿用 `~/.gwork/sessions/` 的 ndjson 格式与 `.stream.ndjson` 回放
- WS 帧协议与现有前端兼容（reason / text / action_* / hitl / question / retry / done / error / trace，
  带 runId / eventSeq / phase）
- HTTP 端点镜像 `/web/chat/*` 接口面

实测：`gwork --serve` 能直接读到 Java 内核留下的全部历史会话与模型配置，零迁移。

## 性能（2026-10-27 实测，与 Java 内核同机对拍）

对拍口径：同一份真实数据的隔离副本（383 会话 / 95 MB stream / 236 模型 / 22 个会话根），
两个内核各指向独立 `GWORK_HOME`，node 客户端 + keep-alive，预热 12 次后取 20 样本中位数。
**不要用 PowerShell 的 `Invoke-WebRequest` 计时**——它有约 25 ms 固定开销，会淹没差异
（同一端点 PS 测 41 ms、node 测 12.6 ms）。

| 端点 | Rust | Java | 倍率 |
|---|---|---|---|
| `usage/stats` 稳态 | 14.3 ms | 15.1 ms | 1.1x |
| `usage/stats` 冷读（账本缺失，全量重建） | 2866–4096 ms | 5485–5516 ms | 1.3–1.9x |
| `chat/meta` | 0.2 ms | 0.5 ms | 2.2x |
| `llm/models` | 0.2 ms | 0.4 ms | 2.2x |
| `chat/sessions` | 40.5 ms | 74.8 ms | 1.8x |
| 12 路并发 `sessions` | 128 ms | 167 ms | 1.3x |
| 跨端点干扰（6 并发 usage 下的 meta） | 0.2 ms | 0.5 ms | — |

正确性逐字段对齐：`totalTokens` 4656411461 逐位相同、`sessionCount` 180、`messageCount` 568、
`topModel` 与百分比一致、heatmap 371 格 **0 处不匹配**、账本文件大小逐字节相同（跨内核可互读）。

## 实现状态（2026-10-27 口径）

**已可用**：单机交互式编码主链路（input → ReAct → 工具 → 帧流 → 落盘 → 回放）真实可运行；
Loop 定时调度、附件、Git、项目管理、临时产物过滤、变更账本、ACP、用量统计账本均有实质实现。

对 Java 内核的覆盖度：HTTP/WS 端点 130/149（聊天主链路完整，设置侧仍有缺口）、
工具 24/51。

**尚不具备替代 Java 内核的条件**，阻断级缺口（按修复优先级）：

1. **上下文压缩完全缺失** —— 只有 30 条消息的条数窗口，零 token 感知，长会话必撞供应商上限报 400
2. **历史重建丢弃全部 tool 消息** —— `session/mod.rs` 的 `to_chat_messages` 对 TOOL 角色
   `return None` 且 `tool_calls: None`，跨轮工具上下文全丢，并违反
   「assistant.tool_calls 后必须紧跟 tool 消息」的供应商契约
3. **无鉴权 + CORS 全开 + bash 可执行任意命令** —— Java 侧有 `WebAuthFilter` 全量 Basic Auth 校验，
   这里 `allow_origin("*")`，同网段任意网页可跨源驱动本机 shell（远程代码执行级风险）
4. **HITL 审批门仍不完整** —— 形态轴已对齐 Java 的 9 个正则（`core/src/hitl.rs`），但
   **路径轴未实现**（Java 的 `BashPathGuard` 有 2092 行），`Set-Content D:\out\f.txt x`
   这类写向工作区外的命令仍会放行；且一次批准仍是 run 级而非逐次，`write`/`edit` 不受门控
5. **挂起点仅内存态** —— 进程重启后 HITL / ask_user 挂起丢失，会话永久卡在「等待」态
6. **变更账本 `finish()` 未接入主聊天链路** —— 交互式 run 的 manifest 永远 `ready:false`，
   增删行数恒为 0，bash 侧变更完全不入账
7. **steer 与 queue 无消费者** —— 插话/排队消息返回 `accepted` 但什么都不会发生
8. **子代理编排退化** —— `multitask` 前台分支是串行的（描述却写 "in parallel"），
   子代理拿不到 MCP 工具；`team/mod.rs` 与 `server/loop_runner.rs` 硬编码
   `hitl_approved: true`，子代理与 Loop 任务完全绕过审批门
9. **IM 通道传输层未接通** —— 13 个端点已按契约返回，但飞书/钉钉的 WebSocket Stream
   与微信的 ilinkai 轮询尚未实现（宁可返回 501 也不返回假 `bound:true`）
10. **远控通道未移植** —— 旧壳的 9 个 `remote_*` 命令（SSH/WSL/deploy/tunnel/mirror/secrets，
    约 8185 行 Rust）尚未搬进新壳，前端调用报 `Command remote_list not allowed by ACL`

### 2026-10-27 已修复（本轮）

- **用量统计账本**（`core/src/usage_ledger.rs`）—— 磁盘态月度分片 + 每会话水位（ts/size）+
  跨月继承（防历史翻倍）+ 原子写 + 已删会话归档保留；与 Java 共享同一份账本文件，
  5 个测试用真实 Java 写入字节验证往返不丢字段
- **归档扫描根不全** —— 原本只扫 `projects.json`（12 项），Java 扫 `session-roots.json`
  的 22 个根 / 556 条绑定，导致少算 1.1 亿 tokens；已补 `SessionRoots::registered_roots()`
- **模型按 uid 归组** —— 原本按名称聚合，服务商改名后同一模型分裂成两行
  （cacheRanking 49 项 vs Java 18 项）
- **`serde_json` 开启 `preserve_order`** —— 否则每次保存把 236 个模型重排成字母序，
  前端按「provider 与上一项不同」分组会碎裂成上百个交替组头
- **`persist_settings` 改逐模型合并** —— 原本用固定字段列表重建，会抹掉 `description`
  与 Java 侧的 `userAgent`/`uid`/`capabilities`/`contextLength`/`proxy`
- **双写源数据丢失** —— `providers_remove` 等 5 个 handler 只改磁盘不更新内存态，
  而 `persist_settings` 会把内存态整体写回 → 已删模型连同 provider 的 apiKey 复活；
  已改为磁盘为唯一真相源 + 写后重载
- **MCP 配置反序列化** —— `McpServerConfig` 已加结构体级 `#[serde(default)]`，
  UI 写入的 JSON（有 `type` 无 `transport`）不再整表失败
- **`GWORK_HOME` / `--home` 支持** —— 原本静默忽略该环境变量去读 `~/.gwork`，
  表现为「数据全丢」；已实现四级解析（override → GWORK_HOME → GOURDAI_HOME → 真实 home）
- **`acp/info` 契约** —— 原本返回 `launcherReady` 而前端读 `ready`（就绪横幅永远显示未就绪）、
  Windows 直接返回 `.bat` 路径而编辑器无法执行（Java 用 `cmd /c` 包装）、
  models 是字符串数组导致丢失 thinkingLevels 档位
- **`UsageInfo` 补缓存字段** —— 原本 Rust 自产会话的缓存命中率恒为 0；已支持
  OpenAI（`prompt_tokens_details.cached_tokens`）与 Anthropic（`cache_*_input_tokens`）双方言，
  并移植 Java 的 `normalizeInputTokens` 数值自洽判据（不按方言分支，避免上游归一后重复计入）
- **`grep`/`glob` 不再饿死 HTTP 服务** —— 原本在 async fn 内联同步遍历，一次无命中的 grep
  会读完整个工作区并阻塞 tokio worker；已改 `run_blocking` offload + 20000 条遍历上限
  （上限触发时显式告知，避免静默部分扫描被误读为「符号不存在」）
- **`RUST_LOG` 不再被静默覆盖** —— 原本 `add_directive("gourd_work_core=info")` 会压过用户设置，
  导致 debug 诊断无法开启

**整块缺失的能力域**：OpenAPI 网关、LSP、技能市场安装链、7 种团队协作协议、
CodeTalent 的 11 个语言 Provider、`memory_consolidate`、后台通知中心。

**降级实现**：`websearch` 从 Exa MCP API 降为 DuckDuckGo HTML 抓取（改版即静默失效）；
`webfetch` 从 markdown + YAML Front Matter 降为纯文本去标签。
