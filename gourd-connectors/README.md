# gourd-connectors — GWork 官方连接器仓库

GWork 桌面端「连接器 · 官方」目录的**唯一数据真源**。数据与客户端代码分离：
**全部条目编译期内置、随桌面端发版更新**（`gourd-work/core/src/mcp/registry.json.gz`
经 `include_bytes!` 编译进 Rust 内核）；**不连自家后台**，admin 不再有任何上传入口，
也没有远程增量拉取链路。用户在连接器页点「连接」时，CLI 形态条目才按需安装
官方 npm 包（Node 运行时由客户端自动准备），凭据由厂商 CLI 自管。

## 目录结构

```
connectors/<name>/
  mcp.json                      # Agent Plugins 1.0.0：MCP 端点（与规范同形；CLI 形态无此文件）
  .gwork-plugin/plugin.json     # Agent Plugins 1.0.0：display 多语言 + cn.gourd.gwork 扩展
  skills/<skillname>/           # CLI 形态：厂商官方技能（SKILL.md 根部 + LICENSE 必备）
featured-source.json            # GWork 自营条目真源（腾讯文档扫码/腾讯会议 Token/TAPD）
scripts/
  import-from-wb.mjs            # 从 WorkBuddy 公开仓库导入 + 实测分级转换（可重跑）
  import-cli.mjs                # 4 条首版 CLI 连接器生成（钉钉/飞书/企微/腾讯会议，可重跑）
  import-wb-cli-batch.mjs       # 24 条 WB 公开 CLI 批量生成（npm 元数据实测，可重跑）
  import-wb-cli-batch.report.json # 24 条实测元数据审计报告（package/version/bin/license）
  probe-dcr.mjs                 # OAuth 动态客户端注册（DCR）开放实测
  zip-store.mjs                 # 零依赖 zip 编解码（store/deflate + CRC32，供打包/验证共用）
  build-snapshot.mjs            # connectors/* → 三份快照产物（见下）
  verify-cli.mjs                # CLI 数据契约验证（zip 解包/许可/三份字节一致/护栏）
dist/
  registry.json                 # 明文快照：{version, generatedAt, entries:[...]}（审计/契约测试用）
../gourd-work/core/src/mcp/
  registry.json                 # 内核明文快照（与 dist 逐字节一致，审计/契约测试用）
  registry.json.gz              # Rust include_bytes! 编译期内嵌真源（gzip level 9 / mtime=0）
```

- `.import-src/` 是导入原料（WorkBuddy 公开 zip 解包 + 端点实测结果），**不发布**。
- `.cli-src/` 是 CLI 导入原料暂存（npm tarball / GitHub 仓库解包 / WB 缓存副本），
  **不发布不入库**；技能成品在 `connectors/<name>/skills/`（入库，根 `.gitignore`
  已豁免 `*.md` 吞噬）。`import-cli.mjs` 优先读已入库的
  `connectors/<name>/.gwork-plugin/plugin.json`（display/cli_spec 基底）与
  `connectors/<name>/skills/`（技能真源）；`import-wb-cli-batch.mjs` 从
  `.import-src/connectors/<id>/{ai.workbuddy/cli.json,.codebuddy-plugin/plugin.json,skills/}`
  重建 24 条，并用 `npm view <pkg> version bin license --json`（npmmirror）锁定
  package/version/binPath/license。两者均无需本机 WorkBuddy 安装即可幂等重建。
- 三份产物由 `build-snapshot.mjs` 一次写出：`dist/registry.json` 与内核明文
  `registry.json` 字节一致；`registry.json.gz`（`zlib.gzipSync(text,{level:9,mtime:0})`）
  解压后与明文逐字节一致，`version`/`generatedAt`/`entries` 三份完全相同。
- **重跑会重建 MCP 条目，但保留全部 28 条 CLI 与 3 条 featured**：
  `import-from-wb.mjs` 在清空 `connectors/` 前按 `kind:"cli"` 动态发现全部 CLI 目录
  并快照到系统临时目录，落盘后原样恢复并逐文件 SHA256 校验，缺一即
  `process.exit(1)`（禁止静默丢失）。

## 条目契约（与内核 `mcp::registry` 对齐）

`plugin.json` 的 `extensions["cn.gourd.gwork"]`：

| 字段 | 说明 |
|---|---|
| `auth` | 授权声明（非密钥）。`authType`: `oauth`（浏览器登录/扫码，标准 OAuth 2.1 + DCR）/ `token` / `qrcode_poll` / `none` / `cli_login`（CLI 形态）。字段白名单与内核 `sanitize_auth_decl` 一致 |
| `display` | `name`/`name_en`/`description_zh`/`description_en`（厂商功能描述，宿主产品名清洗为 GWork） |
| `categories` | 复用内核 `mcp::market::categories()` 的 key，禁止自造死分类 |
| `tier` | 实测分级：`open`（无鉴权直连可用）/ `oauth`（401 + OAuth 元数据可发现 + DCR 实测开放）/ `verified`（自营）/ `cli`（CLI 连接器，见下节）。`auth-unknown`/`dead` 不收录 |
| `probedAt` | 实测时间，审计用 |

## CLI 连接器形态（共 28 条，全部内置随发版）

首版 4 条：`dingtalk`（dingtalk-workspace-cli@1.0.68，Apache-2.0）、`feishu`
（@larksuite/cli@1.0.100，MIT）、`wecom`（@wecom/cli@1.3.4，MIT）、`tmeet`
（@tencentcloud/tmeet@1.1.0，MIT）。2026-11 用户拍板扩到 28 条：新增 24 条
（`import-wb-cli-batch.mjs` 从 WB 公开仓库缓存导入），package/version/binPath 全部
由 `npm view` 实测锁定，明细见 `scripts/import-wb-cli-batch.report.json`。

- **无 mcp.json**：快照条目 `server_config: []`，带 `kind:"cli"`、`cli_spec`、
  `skills`（清单）、`skills_zip`（技能目录 zip 的 base64）。
- **cli_spec 全 argv 数组**（禁止自由 shell 字符串）：`{package, version, binName,
  binPath, npmEnv?, auth|authSteps, status, unauth}`。`binPath` 是 npm 包内可执行
  相对路径（Rust 用 `node <binPath> <argv...>` 直跑），不得含 `..`/绝对路径/盘符。
  所有 `argv` / `status.argv` / `unauth.argv` 必须是字符串数组；飞书第一步
  `authSteps[0].skipIf` 也必须是**字符串数组** `["config","show"]`（Rust
  `CliAuthStep.skip_if` 为 `Option<Vec<String>>`，写成对象会导致 serde 整体解析失败）。
  `status.matchJson` 为对象（值转字符串）、`matchRegex` 为合法正则；渠道参数
  （`--source workbuddy` / `callerUmt` / WB 渠道标志 `--workbuddy`）一律不带。
  `build-snapshot.mjs` 与 `verify-cli.mjs` 均有形态护栏（含 Rust serde 形态模拟）。
- **技能许可合规**：每套技能目录根部必须有 `SKILL.md` + `LICENSE`。首版 4 条沿用
  厂商许可全文（Apache-2.0/MIT）；新增 24 条 WB 缓存技能多数无 LICENSE 文件，
  按 `npm view <pkg> license` 实测字段写入（查不到写
  `UNLICENSED — skills documentation from vendor public CLI package; see package repository`
  兜底并在生成报告列出），不伪造许可全文。技能文案 debrand（品牌整词
  WorkBuddy → GWork、元数据命名空间 `ai.workbuddy.*` → `ai.gwork.*`），不复制
  WorkBuddy 品牌文案/图标。
- **大小护栏**：原 6MiB/7MiB/8MiB 三档是远程上传的传输限额，本轮全部内置 +
  gzip 内嵌后已作废；改为单条 `skills_zip` base64 ≤16MiB、全表 ≤64MiB、快照文本
  ≤64MiB 的合理性检查（防异常技能包/zip bomb）。目录数 <203 或 CLI 条数 ≠28
  一律 FATAL，超限/残缺 `build-snapshot` 报错退出。zip 为零依赖手写
  （store/deflate + CRC32），与内核 `skills/market.rs` 解包器兼容。
- **钉钉旧条目替换**：`featured-source.json` 的 `featured:dingtalk`（stdio 手填凭证）
  已删除，由 CLI 形态（同 id `official:dingtalk`）；`official:tencent-meeting`
  （token MCP）保留，`tmeet` 是独立新增条目。
- **可重跑幂等**：`import-from-wb.mjs`（重建 MCP 条目，自动保留/校验全部 CLI 与
  3 条 featured）、`import-cli.mjs`（首版 4 条）、`import-wb-cli-batch.mjs`
  （新增 24 条）、`build-snapshot.mjs`（生成三份快照）、`verify-cli.mjs`（验证）。
  推荐发布链：
  `node scripts/import-wb-cli-batch.mjs` → `node scripts/build-snapshot.mjs`
  → `node scripts/verify-cli.mjs`。`version` 是 entries 内容哈希；内容哈希未变时
  `build-snapshot.mjs` 复用现有 `generatedAt`，gzip 用 `mtime:0`，同内容重跑
  三份产物字节完全一致（`GWORK_REGISTRY_FORCE_TS=1` 可强制刷新时间戳）。

## 收录原则

1. **只收录实测可连的**：initialize 探测 200 → `open`；401/403 且 RFC9728/8414
   元数据可发现 → `oauth`。其余（需私有密钥、死链、带自家渠道依赖的 CLI 包）
   一律不进目录。
2. **URL 清洗**：剥离渠道归因参数（如 `?invite=WORKBUDDY`），不冒用他家渠道身份。
3. **不搬商标素材**：图标不复制 WorkBuddy 资源，客户端用名称首字占位；描述保留
   厂商 functional 原文（事实性描述），来源在 `source` 字段注明。
4. **腾讯文档特例**：保留 GWork 已验证的 `qrcode_poll` 真扫码形态（微信/QQ 扫码，
   无需浏览器跳转），优先于通用 OAuth。

## 发布流程（随客户端发版内嵌）

```
node scripts/build-snapshot.mjs          # 生成 dist/registry.json（明文审计）
                                          #   + core/src/mcp/registry.json（明文契约测试）
                                          #   + core/src/mcp/registry.json.gz（include_bytes! 内嵌真源）
node scripts/verify-cli.mjs              # ALL PASS：28 条 CLI / 三份产物字节一致
# 构建桌面端：Rust 编译期把 registry.json.gz 打进二进制，无运行时网络拉取。
```

**客户端不再启动后延迟拉取、不再每 6h 增量比对版本**；admin 的
`POST /api/connector-registry` 上传入口与 `GET /api/connector-registry.json`
下发端点均已删除（由其他子代理处理），历史章节仅保留作审计记录。
