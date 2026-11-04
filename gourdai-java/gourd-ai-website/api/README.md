# GWork 官网 API

独立部署的 Node.js 24 服务，只有 Node 内置模块依赖（包括 `node:http`、`node:crypto`、`node:sqlite`）。服务目录为 `gourd-ai-website/api`，不会参与根 Maven 构建。

## 运行

```powershell
cd gourd-ai-website/api
$env:GWORK_USAGE_CLIENT_TOKEN = '部署时生成的长随机共享 token'
$env:GWORK_USAGE_DB = 'D:\data\gwork-usage.sqlite' # 可选，默认 api/data/usage.sqlite
$env:PORT = '8787' # 可选
npm start
```

Node.js 24 的 `node:sqlite` 可用性是硬性要求。生产环境应使用 HTTPS，并将 API 置于反向代理后，例如把 `https://www.example.com/api/` 代理到 `http://127.0.0.1:8787/api/`；静态官网可通过同源路径访问 GET 统计。

环境变量：

- `GWORK_USAGE_CLIENT_TOKEN`：必填，服务启动时不能为空；客户端请求也必须携带 `X-GWork-Client-Token`。
- `GWORK_USAGE_DB`：SQLite 文件路径，可选。
- `GWORK_USAGE_RETENTION_DAYS`：允许接收的最早小时，默认 90 天。
- `GWORK_CORS_ORIGIN`：可选，唯一允许的跨域 Origin；不设置时默认不返回跨域许可。
- `PORT`：监听端口，默认 8787。

## API

`POST /api/v1/usage/batches` 接收客户端原始 JSON bytes。请求必须有客户端生成的 `X-GWork-Device-Id`、`X-GWork-Batch-Id`、`X-GWork-Public-Key`（X509/SPKI DER Base64）、`X-GWork-Signature-Algorithm: Ed25519`、`X-GWork-Signature`（Base64）和共享 token。签名覆盖原始 body bytes。body 形如 `{deviceId,batchId,hour,models}`，models 行包含 `model,inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens,eventIds`。

`GET /api/v1/model-stats?period=24h|7d|30d|all` 返回官网约定的 `code/data` JSON，仅公开脱敏后的模型聚合数据；不输出 provider、channel、apiUrl、deviceId 或 batchId。

## 安全边界

共享 token 是阻止普通直接接口刷量的第一道门槛，但桌面客户端中的 token 存在被逆向提取的风险，因此排行榜绝不能用于奖励、结算或计费。Ed25519 签名可防止 body 被篡改；deviceId 与公钥绑定；SQLite 的批次唯一约束、payload hash 和 eventId 唯一约束可防止普通重放和重复累加。服务限制 body 1 MiB、事件总数和单项 token 数，拒绝过期/超前小时、URL/疑似密钥模型名及未知字段。

默认不跨域；配置 `GWORK_CORS_ORIGIN` 后，仅对完全匹配的 Origin 返回 CORS 许可，并支持 OPTIONS 预检。POST 使用 `no-store`，GET 使用短缓存。

## 测试

```powershell
npm test
```
