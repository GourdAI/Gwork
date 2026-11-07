# GWork uni-app-x 工程集成说明

> 本目录 `gourd-work-app/gwork-app/` 是 **可直接独立维护的 uni-app-x 工程副本**：从本地 vendor 上游复制后按 9 张 WorkBuddy 参考图改造。
> 本文说明来源、逐项改动、复用边界、与 `mobile/` H5 契约的关系、编译运行方法、桌面内核接入点与 TODO。
> **状态：源码改造完成；本机已用 HBuilderX 5.34 CLI 完成真实编译与 Android 云打包（见第 6 节），产出新版 APK。**

---

## 1. 上游来源与合规

| 项 | 值 |
| --- | --- |
| 上游项目 | DCloud `uni-ai-x` |
| 仓库 URL | `https://gitcode.com/dcloud/uni-ai-x.git` |
| 分支 / tag | `v3.1`（`origin/v3.1`） |
| commit | `f9fc94b1d062cd982febc426e7f35435664e7033`（2026-11-03 20:02:10 +0800，`Update README.md`） |
| 模块版本 | `uni_modules/uni-ai-x/package.json` → `3.1.0` |
| 许可证 | **Apache-2.0**；根目录 `license.md` 保留未删（完整条文） |
| 本地 vendor | `gourd-work-app/vendor/uni-ai-x/`（394 文件 / 36MB，含 `.git`） |
| 本工程副本 | `gourd-work-app/gwork-app/` |

复制策略：使用 PowerShell `Copy-Item -Recurse` 复制上游全部顶层项，**排除 `.git` / `node_modules` / `unpackage`**（上游 `.git` 实测 15.7MB / 27 文件，未带入副本）。副本实测 **413 文件 / 36.69MB**（上游工作区 394 文件 / 36.39MB，外加本次新增的 19 个文件）。其中 `uni_modules/` 占 36.09MB，主要是上游 Markdown 渲染链的原生二进制：`libuni-ai-md.so` 5.24MB、`uni-ai-md.har` 5.19MB、`libscopeparser*.so` 系列 ~8MB、`mermaid.min.js` 3.19MB、`tex-svg-full` 2.17MB。这是刻意取舍：**保留上游全部源码与静态资源，而非仅必要子集**，这样流式对话、Markdown 原生渲染、多轮会话运行时的所有依赖都完整可用，vendor 与副本可直接 `diff -r` 对照；若后续要瘦身，可裁剪 `uni_modules/uni-ai-md`、`uni-highlight`、`uni-cmark` 的非目标平台 `.so/.har/.xcframework` 二进制，但会削弱后续对话能力接入，需另行评估。

保留的上游合规与说明文件：`README.md`、`license.md`、`uni_modules/uni-ai-x/changelog.md`、`uni_modules/uni-ai-x/readme.md`、各 `uni_modules/*/package.json`。`vendor/uni-ai-x` 保持干净上游（`git status --porcelain` 为空，HEAD 仍为 `f9fc94b`），便于 diff。

---

## 2. 改动清单（逐条对应 MOBILE-UI-GAP.md 的 D1–D10 与移植步骤表）

| 文件 | 动作 | 对应偏差 / 移植步骤 | 原因 |
| --- | --- | --- | --- |
| `pages.json` | 改 | D3/D4/D10、步骤 1/2 | 启动首页改为 `pages/tasks/tasks`；新增 4 个主页面；新增原生 `tabBar`（4 项、选中 `#141416`、未选中 `#9b9ba2`、背景 `#fafafa`、`borderStyle: white` 无顶部分隔线）；上游 3 个聊天页保留为「对话能力页」但不再是启动页；**无任何 pair/配对前置页，无任何强制跳转** |
| `static/tabbar/*.png` (8) | 新增 | D4、步骤 2 | `iconPath`/`selectedIconPath` 全部指向实际存在文件，避免 404；用 `tools/generate-tabbar-icons.cjs`（零依赖 Node 脚本）生成 81×81 RGBA PNG，形状对齐 `mobile/js/icons.js` 的 tabTask/tabLoop/tabDiscover/tabMine 及 Solid 变体 |
| `static/robot.png` | 新增 | 步骤 3 | 复用 `mobile/assets/robot.png`，首页机器人图；不依赖网络资源 |
| `App.uvue` | 改 | D1/D2/D3、步骤 1 | `onLaunch` **只做** `initWorkbuddyTheme()`：默认主题「系统」、浅色为默认观感、三态 `system/light/dark`；移除上游任何启动跳转（v3.1 上游实际已无配对门禁，此处显式保证并注释）；全局样式 `.gw-page-root` 用 `position:absolute; top/right/bottom/left:0` 铺满视口（uni-app-x 中等价于 `100dvh` 的写法），不自绘状态栏时间，只保留 `env(safe-area-inset-top/bottom)` 占位；tabBar 由原生渲染 |
| `uni.scss` | 改 | D1、样式 token 对齐 | 新增 `$gw-*` SCSS 常量，逐项对齐 `mobile/css/theme.css`：`#fafafa / #ffffff / #f2f2f4 / #141416 / #4a4a50 / #9b9ba2 / #ececef / #f0f0f2 / #0fbc9b / #3b82f6 / #d6d6da`。uni-app-x App 原生渲染不保证支持 `:root[data-theme]` 与运行时 CSS 变量替换，故静态值用 SCSS 编译期展开；深色与运行时切换见下一条 |
| `common/workbuddy-theme.uts` | 新增 | D1、步骤 4 | UTS 类型化主题状态：浅/深 token 常量、`rootStyle()/surfaceStyle()/textStyle()/accentBgStyle()` 等 `:style` 内联字符串 helper；`uni.getSystemInfo` 的 `osTheme/appTheme`(App)/`hostTheme`(Web/MP) 解析系统态；`uni.onAppThemeChange`/`uni.onHostThemeChange` 监听；`uni.setAppTheme` 应用强制态（仅 App）；持久化键 `gwork.workbuddy.theme.v1` / `gwork.workbuddy.haptics.v1`；各 tab 页 `onShow` 重读，无需全局事件总线 |
| `common/workbuddy-data.uts` | 新增 | D5/D6/D8/D9、步骤 3 | `mobile/js/data.js` 的 **UTS 类型化唯一翻译**：`TABS / SUGGESTIONS / DISCOVER_GROUPS / SETTINGS_ROWS / QUICK_ACTIONS / SHEET_LIST_ROWS / DEVICES / MODELS / BRAND / THEMES / ACCENT`。数字、文案、顺序不增删；**`BRAND` 为 `GWork` / `云电脑` / `GWork，我帮你`**（MOBILE-UI-GAP.md 第 174 行的边界要求，与 `mobile/js/data.js` 一致）；4 个 `.uvue` 页面全部从这里取数，避免 UI 契约散落 |
| `pages/tasks/tasks.uvue` | 新增 | D5/D6/D9、步骤 3/5、图 75/74/76/78/79/82 | 首页：菜单胶囊 + GWork 标题 + 云电脑 >、机器人 + 大标题 + 4 建议胶囊 + 换一换（两组轮换）、两态输入框（空闲单行 / 激活多行 + Hy3 模型 + 发送）、选择设备面板、⊕ 快捷面板、选择模型面板、侧滑抽屉。状态机移植自 `app.js renderHome()/renderInput()/popups` |
| `pages/loop/loop.uvue` | 新增 | D7、步骤 3/5、图 77/74 | 定时任务：设备胶囊 + 「任务 / 结果」双 Tab + 空态「暂无自动化任务」+ 青绿 FAB ＋ + 设备面板 |
| `pages/discover/discover.uvue` | 新增 | D8、步骤 3/5、图 80 | 发现：居中标题 + 3 分组卡（资料库 / 专家·技能·连接器 / 项目），按 `DISCOVER_GROUPS.group` 拆分渲染，等价于 `app.js` 的 reduce |
| `pages/mine/mine.uvue` | 新增 | D1/D8、步骤 3/5、图 81 | 我的：资料卡（B / Blake / › / 体验版 + 升级套餐 / 我的积分 3363.38 ›）+ 设置卡（主题三段 + 6 行设置）+ 青绿触感开关；`onThemeClick` 调 `setWorkbuddyTheme`，`onHapticsToggle` 持久化 |
| `uni_modules/uni-ai-x/config.uts` | 改 | D9、步骤 6 | `llmModelMap` 由上游 10 项 qiniu 模型改为 GWork 8 项：快速/均衡/极致/Hy4 preview/Hy3/DeepSeek-V4.1-Flash/GLM-5.3/GLM-5.3-Flash，默认 `Hy3`（与 data.js `MODELS` 顺序一致）；`currentUser` 改 GWork 占位；`userCenterPage` 指向 `/pages/mine/mine` 占位；**删除上游所有真实密钥、appId、secret、uniCloud 登录调用**；`getToken()` 保留宿主注入/自有服务端 TODO，未接后端时抛明确错误，不静默伪造 token |
| `tools/generate-tabbar-icons.cjs` | 新增 | D4 | 可重复生成 8 个 tabBar PNG 的构建期脚本（非运行时依赖） |
| `tools/self-check.cjs` | 新增 | 静态自检 | Node 自检脚本（65 项），见第 7 节 |
| `INTEGRATION.md` | 新增 | 交付说明 | 本文 |

### D1–D10 逐条闭环

| 偏差 | 参考图要求 | 本工程落点 |
| --- | --- | --- |
| D1 主题反了 | 全浅色、默认「系统」、三态 | `App.uvue → initWorkbuddyTheme()` + `workbuddy-theme.uts` + `uni.scss` `$gw-*` + `pages/mine` 分段控件 |
| D2 页面没铺满视口 | 内容纵向分布到底部 Tab | `App.uvue` 的 `.gw-page-root` 四边归零绝对定位 + `.gw-page-body flex:1;min-height:0`（uni-app-x 中等价 `100dvh`）+ `env(safe-area-inset-*)` |
| D3 所有 Tab 被配对内核劫持 | 4 Tab 各自独立可逛 | `pages.json` 首个 page 为 tasks；`App.uvue` onLaunch 无 `redirectTo/reLaunch`；无 pair 页；4 个 `.uvue` 各自独立渲染 |
| D4 缺失底部 4 Tab | 任务/定时任务/发现/我的 | `pages.json tabBar` 4 项 + 8 个真实 PNG（选中实心/未选中线性） |
| D5 缺失首页欢迎态 | 机器人 + 大标题 + 4 建议胶囊 + 换一换 | `pages/tasks/tasks.uvue` + `static/robot.png` + `SUGGESTIONS` 两组轮换 |
| D6 顶栏形态错 | 圆形「＝」+ 品牌大标题 + 云电脑 > | `tasks.uvue` 的 `.gw-head-menu` 两横线 + `BRAND.name=GWork` + `BRAND.device=云电脑` |
| D7 输入框形态错 | 两态胶囊，含语音/模型/+/发送 | `tasks.uvue` 两态 `textarea`（空闲单行 / 激活多行 + Hy3 选择器 + 发送箭头） |
| D8 三页内容整体缺失 | 定时任务/发现/我的 | `loop.uvue`（双 Tab + 空态 + 青绿 FAB）、`discover.uvue`（3 分组卡）、`mine.uvue`（资料卡 + 6 行设置 + 主题分段 + 触感开关） |
| D9 4 个交互面板缺失 | 抽屉/设备/＋/模型 | `tasks.uvue` 的 4 个面板 + `loop.uvue` 设备面板；数据来自 `QUICK_ACTIONS/SHEET_LIST_ROWS/DEVICES/MODELS` |
| D10 强调色缺失 | 青绿 #0fbc9b 用于勾选/FAB/开关/光标 | `$gw-accent`、`ACCENT`、`accentBgStyle()` 覆盖 FAB、开关、勾选、输入光标 |

D10（「无 host 就强制跳转配对页」启动门禁）：上游 v3.1 `App.uvue` 已不含此逻辑；改造后 `App.uvue onLaunch` 与 `pages.json` 都不含 `pair` / 配对页 / `reLaunch` / `redirectTo`，**未配对也能逛全部 4 个 Tab**。

### 颜色 token 策略说明

`mobile/css/theme.css` 用 `:root[data-theme]` + CSS 变量实现浅/深两态。uni-app-x 的 App 端是原生渲染（非 WebView），不能依赖全局 CSS 变量选择器与运行时变量替换，因此：

1. 静态浅色值 → `uni.scss` 的 `$gw-*` SCSS 常量（编译期展开，跨端稳定）；
2. 深色与三态运行时切换 → `common/workbuddy-theme.uts` 的 UTS 常量 + `:style` 内联字符串（页面 `onShow` / 主题点击时重算）；
3. `theme.json` 的 `@navigationBarBackgroundColor` 等占位符只负责系统导航栏/窗口背景的浅深两态，与页面 token 不冲突；
4. 项目**不写** CSS `var(--gw-*)` 自定义属性，避免 App 端不生效。上游 `uni_modules` 内部的 `var(--bg-primary)` 属上游组件自有实现，未改动。

### UTS / .uvue 语法约束

- 全部新页面使用 `<script lang="uts" setup>`、`ref<T>` / `computed<T>` / `function(...): void` 显式类型；
- 只用 `view / text / image / scroll-view / textarea / switch 风格的 view`；
- 不用 Vue2-only 写法（`this.$set`、`filters`、`v-model` 自定义组件、`slot-scope`、`$children`、`Vue.prototype`）；
- 不用 `<style scoped>` 深层选择器、不用 `:root[data-theme]`、不用 `100dvh`（改为四边归零绝对定位）；
- 条件编译用 `// #ifdef APP` / `// #ifdef WEB || MP` / `// #endif`（与上游 `sdk/index.uts` 一致）。

---

## 3. 直接复用 uni-ai-x 的能力 / 按参考图自写的 UI

### 直接复用（未改动上游实现）

| 能力 | 位置 | 接入点 |
| --- | --- | --- |
| 流式对话 / SSE / 多 provider 网关抽象 | `uni_modules/uni-ai-x/sdk/index.uts`、`sdk/chat.uts` | `config.uts` 的 `Provider.baseURL` + `getToken()`；`pages/tasks/tasks.uvue` 的 `onSend()` 是预留入口 |
| provider 配置与模型选择 | `uni_modules/uni-ai-x/config.uts`（仅改模型清单/token 策略） | `llmModelMap` / `defaultLLM` / `providerNameList` |
| Markdown 渲染（含代码高亮、Mermaid、数学公式） | `uni_modules/uni-ai-x/components/uni-ai-md-*`、`sdk/markdown.uts` | 后续对话页直接复用 |
| 多轮会话存储 | `uni_modules/uni-ai-x/sdk/storage-manager.uts` | `STORAGE_KEYS.CHAT_LIST` / `uni-ai-msg-*` |
| 上游 3 个对话能力页 | `uni_modules/uni-ai-x/pages/index/index.uvue`、`pages/common/webview/webview.uvue`、`pages/select-text/select-text.uvue` | 在 `pages.json` 中保留注册，非 tab 页，可 `uni.navigateTo` 进入 |
| 主题系统基础设施 | `sdk/index.uts` 的 `initUiTheme/refreshUiTheme/applyAppTheme` | 本项目 `workbuddy-theme.uts` 按同一套 uni API 重新实现三态 |
| `uni_modules` 全部依赖 | 见第 5 节清单 | 复制时完整保留 |

### 按 9 张参考图自写（未复用上游 UI 组件）

- 4 个主页面骨架 `pages/{tasks,loop,discover,mine}/*.uvue`；
- 4 项原生 `tabBar` 配置 + 8 个自生成 PNG 图标；
- `common/workbuddy-data.uts` / `common/workbuddy-theme.uts`；
- 首页 4 面板（设备/快捷/模型/抽屉）、两态输入框；
- `uni.scss` 的 GWork 设计 token 与 `App.uvue` 的全视口根容器。

理由：上游是「单页聊天 + 侧栏会话列表」的信息架构，与参考图的「4 Tab + 首页机器人引导 + 定时任务空态 + 发现分组卡 + 我的设置」不同，无法靠改文案达成；保留上游页作为能力页是最少侵入的复用方式。

---

## 4. 与 `mobile/` H5 实现的关系

- `gourd-work-app/mobile/` 是**可运行、可验证的 UI 契约基准**：`mobile/js/data.js` 是唯一数据基准，`mobile/js/app.js` 是 4 页 render 状态机蓝本，`mobile/css/theme.css` 是颜色 token 基线，`MOBILE-UI-GAP.md` 是 9 图确立的 UI 契约与 D1–D10 偏差清单。本次改造**未修改 `mobile/` 下任何文件**，也未修改 `MOBILE-UI-GAP.md`。
- `gwork-app/` 是把该契约**移植到 uni-app-x 原生渲染**的实现：`common/workbuddy-data.uts` 是 `data.js` 的 UTS 翻译，4 个 `.uvue` 页面按 `app.js` 的 `renderHome/renderLoop/renderDiscover/renderMine/renderInput/popups` 结构重写，颜色对齐 `theme.css`。
- `mobile/` 同时可作为 **web-view 载体**：`uni_modules/uni-ai-x/pages/common/webview/webview.uvue` 已保留注册，后续可把 H5 版本作为某个能力页加载，用于回归比对 UI 契约；但 4 个主 Tab 是原生 `.uvue`，不依赖 WebView。
- 验收关系：任何 UI 文案/层级调整应先改 `mobile/js/data.js` 与 `mobile/js/app.js` 验证，再同步 `workbuddy-data.uts` 与 4 个 `.uvue`，避免两套实现漂移。

---

## 5. 依赖清单（uni_modules）

复制后 `uni_modules/` 共 **14 个目录**（上游完整保留，未联网安装、未执行 `npm install`）：

```
uni-ai-md                        uni-ai-worker
uni-ai-worker-runtime            uni-ai-x
uni-ai-x-openClaw                uni-cmark
uni-config-center                uni-highlight
uni-icons                        uni-id-common
uni-popup                        uni-upgrade-center-app
uts-openSchema                   uts-progressNotification
```

其中本工程 4 个主页面**不直接引用任何 uni_modules UI 组件**（只用内置组件），因此主 UI 无额外插件依赖；`uni_modules` 主要服务于后续接入的上游对话能力页与 Markdown 渲染链（`uni-ai-md` / `uni-highlight` / `uni-cmark`）。App 端自定义基座需打包这些 UTS 原生插件对应的原生库（尤其 `uni-ai-md` 的 `.so/.har`、`uni-highlight` 的 `libscopeparser*.so` 与 `.xcframework`），HBuilderX 会按 manifest 自动提示。

---

## 6. 本机真实编译 / 打包链路（HBuilderX 5.34 CLI 云打包）

### 6.1 环境与账号

| 项 | 本机实测值 |
|---|---|
| HBuilderX | `C:\Apps\HBuilderX`，`HBuilderX 5.34.2026102909`（`ReleaseNote.md` 顶部 5.34.2026102713） |
| CLI | `C:\Apps\HBuilderX\cli.exe`，支持 `project open` / `pack` / `pack --precheck` / `pack --async` / `pack artifact` / `pack status` |
| 登录账号 | `luzw1223@qq.com`（`%APPDATA%\HBuilder X\prefs`，`LAST_SIGN_IN_TIME` 当日） |
| 工程 | 已用 `cli.exe project open --path <本工程>` 导入，`project list` 返回 `gwork-app(UniApp_VUE)` |
| appid | `__UNI__2C8A727`（对齐既有 GWork 官方 APK；上游 `f9fc94b` 自带的 `__UNI__C50103A` 不属于本机账号，云端会拒绝打包） |
| 包名 / 版本 | `com.gourdai.gwork` / `versionName 3.0.4`、`versionCode 26092302` |
| 证书 | `--android.androidpacktype 3`（DCloud 云端证书，与既有官方 APK 签名方式一致） |
| 网络 | 云打包正常提交、排队、出包（无需本地 Android SDK / Gradle / NDK） |

### 6.2 真实命令（可复跑）

```bat
set HBX=C:\Apps\HBuilderX\cli.exe
set PROJECT=C:\work\workspace\gourd\Gwork\gourd-work-app\gwork-app

REM 1) 导入工程（CLI 的 --project 要求「已导入项目」）
"%HBX%" project open --path "%PROJECT%"

REM 2) 纯本地编译前预校验：应返回 ok=true / errors=0
"%HBX%" pack --project "%PROJECT%" --platform android --android.packagename com.gourdai.gwork --precheck true

REM 3) 提交云打包（异步，返回 ticket）
"%HBX%" pack --project "%PROJECT%" --platform android --android.packagename com.gourdai.gwork --android.androidpacktype 3 --ignoreWarnings true --async true --json true

REM 4) 轮询状态；成功后手工下载产物（pack artifact 返回 remoteOnly=true，不自动落盘）
"%HBX%" pack artifact --project "%PROJECT%" --ticket <上一步返回的 ticket> --json true
curl.exe -L -o gwork-android-3.0.4.apk https://app.liuyingyong.cn/build/download/<ticket>
"%HBX%" pack status --project "%PROJECT%"
```

> 本机已实测：`launch app-android --compile true` 因未连接 Android 设备/基座报「启动失败，请重试」，**不代表代码编译失败**；代码编译由 `pack` 提交阶段完成，日志逐页输出「当前工程8个页面，正在编译…」并以「项目 gwork-app 编译成功」结束。首次编译还暴露并修复了 `pages/tasks/tasks.uvue` 的 `max-height: 72%`（uni-app-x 原生渲染只接受 number|px），改为按 `uni.getWindowInfo().windowHeight * 0.78` 同步换算 px 的内联样式；修复后编译日志零 ERROR。

### 6.3 本次交付物与旧 APK 的边界

- 本次交付物：`gourd-work-app/gwork-android-3.0.4.apk`（40,388,962 字节），由 ticket `a69f69e0-da9f-11f1-a09b-c31ada770239` 下载；含 GWork 图形商标、4 Tab 新版 UI、三态主题、`3.0.4 / 26092302`；
- `gourd-work-app/gwork-android-release.apk`（28.8MB / 2026-11-04）是**旧版**：版本 `1.0.0 / 26010101`、含 D1–D10 偏差，**不是本次交付物**；
- `unpackage/` 是 HBuilderX 编译缓存，由 `.gitignore` 忽略；`tools/self-check.cjs` 已改为校验「该目录若存在须被忽略且只含编译缓存」，不再因正常编译产物误报失败。

### 6.4 自定义基座的适用范围

- **云打包正式包不需要自定义基座**：原生插件由云端按 manifest 摇树编译进 APK；
- 自定义基座只用于「运行到手机/模拟器」的**开发调试**（`launch app-android` / 制作调试基座），本机未接 Android 设备，故未制作；
- 若后续改了 UTS 原生插件的 Kotlin / `.so`，需重新制作调试基座再做真机调试，但不影响云端正式包。

---

## 7. 静态自检

工程内有两套互补的 Node 静态自检，均零依赖、可直接运行：

```bat
cd /d C:\work\workspace\gourd\Gwork\gourd-work-app\gwork-app
node tools\self-check.cjs            :: 65 项：本任务交付的自检脚本
node tests\integration-check.cjs     :: 40 项：工程集成自检（含与 mobile/js/data.js 的品牌/主题/强调色一致性）
```

检查项（合并）：

1. `pages.json` 用行级注释剥离（保留 `// #ifdef` 条件编译）后再 `JSON.parse`；因条件编译块内对象带尾逗号无法直接解析，脚本对 `APP-*` 条件块做等价剥离，并输出解析出的 `pages` / `tabBar.list`；
2. 首个 `pages[0].path == "pages/tasks/tasks"`；
3. 4 个 tabBar 页路径都存在对应 `.uvue` 文件，且都注册在 `pages` 中；`pages.json` 引用的 8 个页面路径全部有 `.uvue`；
4. 所有 `iconPath` / `selectedIconPath` 指向的文件真实存在（并校验 PNG 头）；
5. `App.uvue` / `pages.json` / 4 个主页面 / `config.uts` 中无 `pair` / 配对 / 强制跳转（`reLaunch` / `redirectTo`）；门禁检测先剥离代码注释，避免把「不保留配对页门禁」这类说明文字误判；
6. 4 个 `.uvue` 中无 Vue2-only 语法（`Vue.prototype`、`this.$set`、`filters:`、`slot-scope`、`$children`、`<style scoped`、`100dvh`、`:root[data-theme]`、`v-html`），且均为 `<script lang="uts" setup>` 并带 `gw-page-root` 全视口根容器；
7. 上游 3 个对话能力页仍在 `pages.json` 中注册；
8. `config.uts` 中 8 个 GWork 模型名齐备、无 `uniCloud` / `appId` / `secret` 硬编码密钥痕迹（密钥检测同样只看可执行代码）；
9. `common/workbuddy-data.uts` 与 `mobile/js/data.js` 的 `BRAND=GWork`、`DEFAULT_THEME=system`、`ACCENT=#0fbc9b` 一致；`common/workbuddy-theme.uts` 导出 `initWorkbuddyTheme` / `setWorkbuddyTheme`；
10. 上游 `license.md`（Apache-2.0）/ `README.md` / `uni_modules/uni-ai-x/changelog.md` 保留；副本不含 `.git` / `node_modules` / `unpackage`；`INTEGRATION.md` 如实声明本机未编译。

真实输出见本报告第 8 节（两套脚本均 `exitCode=0`）。

---

## 8. 与 GWork 桌面内核的接入点与 TODO

### 8.1 桌面内核现状（来自任务上下文）

- 内核监听 `0.0.0.0`，提供 `webAuthUser` / `webAuthPass` 的 Basic Auth 保护；
- 移动端 App 需要以局域网可达 IP 访问内核（**不能用 `0.0.0.0` 作为客户端目标地址**）；
- 桌面内核与 App 之间需要一层 token 交换 / 宿主注入，避免账号密码落到客户端。

### 8.2 接入点清单

| 接入点 | 文件 | 当前状态 | TODO |
| --- | --- | --- | --- |
| 模型网关 / token | `uni_modules/uni-ai-x/config.uts` | `baseURL` 为 `https://gwork-backend.invalid/v1/chat/completions` 占位；`getToken()` 抛明确错误 | 宿主注入短期 token（自定义基座写 `uni` 存储），或自有服务端用 `webAuthUser/webAuthPass` 换临时 token；替换占位 baseURL 为 `http://<局域网IP>:<port>/v1/chat/completions`；**密钥绝不进客户端** |
| 用户资料 | `config.uts` 的 `currentUser` / `userCenterPage`；`pages/mine/mine.uvue` | GWork 占位 + 静态 Blake 卡 | 登录后注入 `_id/nickname/avatar_file`，积分/套餐走内核 API；如需独立资料页，新增 `pages/profile/profile` 并注册（注意 tabBar 页要用 `uni.switchTab`） |
| 首页发消息 | `pages/tasks/tasks.uvue` `onSend()` | 清空输入 + Toast | 调 `uni-ai-x/sdk` 的 `send()`/SSE，把 `selectedModelId` 映射到 `config.uts` 的 `modelId`，并复用会话存储实现多轮 |
| 模型选择落地 | `pages/tasks/tasks.uvue` 图 82 面板 | 仅本地 `selectedModelId` | 同步 `uniAi.llm.provider/model`（见上游 `uni-ai-x-setting.uvue` 的 `radioChange`） |
| 定时任务 | `pages/loop/loop.uvue` `onFabClick()` | Toast | 新建任务表单 + 桌面内核调度 API；空态换真实列表 |
| 发现分组 | `pages/discover/discover.uvue` `onRowClick()` | Toast | 资料库/专家/技能/连接器/项目详情页与内核 API |
| 设备选择 | `tasks.uvue` / `loop.uvue` 设备面板 | 静态 `DEVICES`（云端 + LAPTOP-0GMU4KOI 离线） | 内核设备发现/在线状态；`0.0.0.0` 仅服务端监听用 |
| 触感反馈 | `pages/mine/mine.uvue` `onHapticsToggle()` | 持久化开关 | 按开关调 `uni.vibrateShort` |
| 语音/文件/拍照 | `tasks.uvue` 快捷面板 | 静态列表 | 接 `uni.chooseImage` / 录音 / 文件上传 |
| 主题 | `workbuddy-theme.uts` | 三态可用，`onShow` 刷新 | App 端 `uni.setAppTheme` 已接；Web/MP 端跟随宿主主题 |

### 8.3 安全约束

- 本工程源码**不含任何真实密钥、token、`webAuthUser`、`webAuthPass`、appId、secret**；
- `config.uts` 明确删除了上游的 uniCloud 登录与明文密钥，并留下宿主注入 / 服务端换 token 的两套 TODO；
- 禁止把桌面内核账号密码写进 `manifest.json`、`.uvue`、`config.uts` 或静态资源；
- 本任务执行期间**未联网上传任何内容**，未执行云打包。

---

## 9. 目录树（本工程新增/改动部分）

```
gwork-app/
├── App.uvue                                  [改] 启动无门禁 + 主题初始化 + 全视口根容器
├── INTEGRATION.md                            [新] 本文
├── README.md / license.md                    [保留] 上游 Apache-2.0 合规
├── index.html / main.uts / manifest.json / theme.json  [保留] 上游
├── pages.json                                [改] 4 tab + 3 对话能力页
├── uni.scss                                  [改] $gw-* 设计 token
├── common/
│   ├── workbuddy-data.uts                    [新] data.js 的 UTS 唯一翻译（BRAND=GWork）
│   └── workbuddy-theme.uts                  [新] 三态主题 + :style helper
├── pages/
│   ├── tasks/tasks.uvue                     [新] 图 75/74/76/78/79/82
│   ├── loop/loop.uvue                       [新] 图 77/74
│   ├── discover/discover.uvue               [新] 图 80
│   ├── mine/mine.uvue                       [新] 图 81
│   └── index/index.uvue                     [保留] 上游旧首页（非启动页）
├── static/
│   ├── robot.png                            [新] 复用 mobile/assets/robot.png
│   ├── tabbar/{tasks,loop,discover,mine}{-active}.png  [新] 8 个 81×81 PNG
│   └── logo.png                             [保留] 上游
├── tools/
│   ├── generate-tabbar-icons.cjs            [新] 图标生成脚本
│   └── self-check.cjs                       [新] 静态自检脚本（65 项）
├── tests/
│   ├── integration-check.cjs                [保留/上游交付] 工程集成自检（40 项）
│   └── ...                                  [保留] 上游其余测试
├── uni_modules/                             [保留 14 个上游模块]
│   └── uni-ai-x/
│       ├── config.uts                       [改] GWork 8 模型 / 默认 Hy3 / 无密钥
│       ├── package.json / changelog.md / readme.md  [保留]
│       ├── sdk/ components/ pages/ ...      [保留] 流式对话 / Markdown / 会话存储
├── workers/ demo/ App.uvue ...              [保留] 上游全部其余文件
```
