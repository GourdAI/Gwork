# gwork-app

GWork 移动端（uni-app x / 蒸汽模式）AI 聊天客户端，编译目标为 Android（Kotlin）、iOS（Swift）、鸿蒙（ArkTS）与 Web/小程序（JavaScript）。

## 品牌

- 品牌名：**GWork**（词条统一走 `locale/*.json` 的 `app.name` / `home.brand`）
- Logo：与桌面端 `gourd-work/desktop/ui/img/logo.svg` 完全同源（黑底白 G，不再做蓝色渐变）
  - `static/logo.png` —— 桌面端原始黑底白 G（首页主视觉、关于页，亮色主题）
  - `static/logo-inverse.png` —— 暗色主题变体（近白底黑 G，与暗色主色近白实底同构）
  - `static/avatar-default.png` —— 默认用户头像（实心圆角黑底 + 白色 G；用户头像语义，勿与主视觉混用）
  - `static/login-mark-light.png` / `login-mark-dark.png` —— 登录页光晕合成贴图（中性光晕 + logo；原生端不支持 radial-gradient，合成为一张图）
  - `static/logos/` —— Android 启动图标 `logo_72x72/96x96/144x144/192x192.png` 与 iOS App Store `logo_1024x1024.png`
- 色系与桌面端 `css/theme.css` 对齐：真中性 zinc 色阶 + 石墨 graphite 主色（亮 `#18181b` / 暗 `#e4e4e7`）；
  暗色主色实底为近白底深字（`text-inverse` 成套取深色）。色板见 `styles/theme.scss`（light/dark 成对维护，组件内禁止写死色值）
- 首页欢迎语与桌面端同源：`locale/*.json` 的 `home.greeting.0~19`（= 桌面端 `app.welcome_greeting`），每次回到首页/新建会话随机轮换

## 开发

- 使用 HBuilderX 打开本目录运行/打包（`manifest.json` 已开启 vapor）
- 类型检查：`npm install` 后执行 `npm run type-check`
- 开发约定见 `AGENTS.md`，评审标准见 `code-review/REVIEW_GUIDE.md`

## 目录速览

| 目录 | 说明 |
| --- | --- |
| `pages/` | 业务页面（登录、首页、对话、我的、设置等） |
| `components/` | 自有通用组件 |
| `hooks/` | 跨页面共享状态（主题、语言、用户、会话） |
| `locale/` | 十二语言词条，与桌面端语言集对齐（zh-Hans / zh-Hant / en / de / ja / ru / el / es / fr / pt / ro / vi）；改动后跑 `node build/verify-i18n.cjs` 校验 key/占位符/品牌词对齐 |
| `styles/theme.scss` | 全局主题变量单一来源 |
| `uni_modules/` | uni-ai-x、rice-ui 等插件模块 |
| `utils/` | 请求封装（`createApiClient` 工厂）等工具 |
| `config/` | 后端模块配置（经 vite define 注入） |
| `static/` | 品牌资产与图标字体 |