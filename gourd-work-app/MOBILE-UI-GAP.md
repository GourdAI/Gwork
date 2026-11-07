# 移动端 UI 对照 WorkBuddy 截图：差异清单与修复结果

> 参考依据：`gourd-work-app/workbuddy-images/` 9 张 WorkBuddy 原始截图（编号 74–82，逐张视觉核验）
> 旧实现取证：`gourd-work-app/.tmp_mobile_probe/v4-*.png`（390×844 H5 逐页探针）+ APK 内 `static/theme.css`
> 修复完成：2026-11-07（本次会话）｜实现载体：`gourd-work-app/mobile/`

---

## 一、WorkBuddy 参考图确立的 UI 契约

### 全局
- **浅色主题**：背景 `#fafafa` ~ 纯白，文字近黑，卡片/胶囊为白底细描边 + 大圆角。9 张截图里**没有任何一张是深色**。
- **强调色**：青绿/teal `#0fbc9b`，只用于：勾选、FAB「+」、开关、输入光标、机器人眼睛、状态点。
- **底部固定 4 Tab**：`任务`（聊天气泡）／`定时任务`（闹钟）／`发现`（指南针）／`我的`（人像）。选中黑色实心图标 + 黑字；未选中灰色线性图标 + 灰字；浅灰白底、无顶部分隔线。
- **圆角规格**：输入框/卡片 ≈ 28–32px，胶囊 ≈ 999px，顶部圆形按钮 ≈ 56px 直径。
- 状态栏为系统原生（不自绘数字时间），底部有系统手势条。

### 页 1 · 任务（首页，图 75 / 79）
- 顶栏：**左侧白色圆形「＝」按钮**（两条横线，非汉堡三线、非返回箭头）；右侧品牌大标题；其下灰色副行 `☁ 云电脑 >`。
- 中部：3D 机器人插画（银灰猫耳耳机机器人、抱笔记本、青绿眼睛）+ 大号加粗欢迎语。
- **4 个白底描边胶囊建议卡**：进行数据分析及可视化／进行文档处理／做一份幻灯片／制作工作台；下方灰色小胶囊 `⟳ 换一换`。
- 底部输入区两态：
  - 未聚焦（图 75）：单行白色大圆角胶囊 `发消息或按住说话...`，左语音波纹，右 `+`。
  - 聚焦（图 79）：胶囊变高为多行，青绿光标 `发消息...`；下排 语音图标、`Hy3 ⌄` 模型选择器、`+`、灰色圆形发送箭头。
- 输入区与 Tab 栏之间保留留白，内容纵向分布、不顶满全屏。

### 页 2 · 定时任务（图 77）
- 顶栏：左侧白色圆角 `☁ ⌄` 设备下拉；居中 `任务 / 结果` 双 Tab（选中黑、未选灰）。
- 中部：浅灰机器人问号占位图 + `暂无自动化任务`。
- 右下角：**青绿色圆形 FAB「+」**。底部 4 Tab（选中「定时任务」）。

### 页 3 · 发现（图 80）
- 居中标题 `发现`；白色圆角分组卡片：第 1 组 `资料库`；第 2 组 `专家 / 技能 / 连接器`（行间细分隔线，左图标右箭头）；第 3 组 `项目`。

### 页 4 · 我的（图 81）
- 居中标题 `我的`。
- 卡片 1：蓝色圆形头像 `B` + `Blake` + `>`；分隔线；`体验版` + 黑色胶囊按钮 `升级套餐`；`我的积分 3363.38 >`。
- 卡片 2：`主题` + 分段控件 `系统 | 浅色 | 深色`（**默认为系统**，白色选中态）；`语言 跟随系统 >`；`字体大小 >`；`朗读设置 >`；`触感反馈` + 青绿开关；`存储空间 >`；`消息通知设置 >`。

### 交互态（图 74 / 76 / 78 / 82）
- **侧滑抽屉**（图 76）：`☁ 云端 ⌄` + `⊕ 新建任务` 大圆角描边按钮 + `暂无云端任务` 灰字空态；右侧主界面压暗露窄条。
- **选择设备 sheet**（图 74）：标题 `选择设备` + 右上 `✕`；两行 `☁ 云端`（**青绿勾靠最右**）／`🖥 LAPTOP-0GMU4KOI` + 灰色 `离线` 标签。
- **「+」扩展面板**（图 78）：顶部三宫格浅灰卡 `拍照 / 照片·视频 / 添加文件`；列表行 `专家 / 技能 / 连接器 / 定时任务 / 录音笔`。
- **选择模型 sheet**（图 82）：居中拖动把手 + 标题 `选择模型` + 右上 `✕`；每行 `图标 + 名称 + 灰色倍率`，选中行右侧青绿勾；`Hy3` 带淡红 `限时免费`；8 行列表 + 底部 `⌄` 展开更多。

---

## 二、旧实现（v4 探针）的 10 项实测偏差 —— 均已在本次修复

| # | 偏差 | 参考图 | 旧实现 | 修复状态 |
|---|---|---|---|---|
| D1 | 主题反了 | 全浅色 `#fafafa`/白，设置默认「系统」 | 纯黑深色写死为默认 | ✅ `css/theme.css` 三态 token；`data-theme` 默认 `system`，浅色为默认观感，`@media (prefers-color-scheme: dark)` 跟随系统 |
| D2 | 页面没铺满视口 | 内容纵向分布到底部 Tab | 844 视口里内容在 ≈570px 处截断 | ✅ `.app-root{height:100dvh}` + `.page-root{flex:1;min-height:0}`；探针实测 rootH=844、rootBottom=844 |
| D3 | 所有 Tab 被「配对内核」劫持 | 4 Tab 各自独立可逛 | 所有页都是 `连接你的 GWork 内核` 表单 | ✅ 完全移除启动门禁，4 页各自渲染；无 `pair` 文案、无配对节点 |
| D4 | 缺失底部 4 Tab | 任务/定时任务/发现/我的 | 完全不存在 | ✅ `js/data.js` 的 `TABS` 单一数据源驱动 `renderTabbar()`，选中/未选中态齐全，无顶部分隔线 |
| D5 | 缺失首页欢迎态 | 机器人 + 大标题 + 4 建议胶囊 + 换一换 | 只有灰色菱形 + `开始一个新任务` | ✅ 从参考图 75 裁出并透明化机器人 `assets/robot.png`；4 胶囊 + 换一换（两组数据可轮换） |
| D6 | 顶栏形态错 | 圆形「＝」+ 品牌大标题 + `云电脑 >` | `‹` 返回箭头 + 二级页标题 | ✅ `.round-btn` + `menu` 两横线图标 + `.brand` 副标题；无返回箭头 |
| D7 | 输入框形态错 | 两态胶囊，含语音/模型选择/`+`/发送 | 单行深灰输入框 + 上箭头 | ✅ `renderComposer()` 两态；聚焦态含 `Hy3` 选择器（可打开模型 sheet）、`+`（可扩展面板）、语音、发送箭头；青绿光标 |
| D8 | 页面内容整体缺失 | 定时任务/发现/我的三页内容 | 被配对页遮挡 | ✅ 三页全部实现：双 Tab + 空态 + 青绿 FAB；3 组分组卡；资料卡 + 6 行设置 + 主题分段 + 开关 |
| D9 | 4 个交互面板缺失 | 抽屉 / 设备 / ＋ / 模型 | 均不存在 | ✅ 4 个面板全部实现，统一 `scrim` + `hidden` 优先级兜底；支持遮罩点击与 Esc 关闭 |
| D10 | 强调色缺失 | 青绿用于勾选/FAB/开关/光标 | 全灰黑 | ✅ `--accent:#0fbc9b` 覆盖勾选、FAB、开关、光标 |

### 旧实现根因（保留供回归分析）
1. **D1 是产品决策偏差**：APK 内 `www/static/theme.css` 注释原文写「深色为默认（移动端 OLED 与夜间使用为主）」，与参考图冲突。
2. **D3 是启动门禁缺旁路**：`App.uvue` onLaunch 里「无 host → 强制 redirect 到 `pages/pair/pair`」为无条件拦截。
3. **D2/D4 方向**：`.page-root` 视口高度配置错误；`pages.json` 未配置 `tabBar`。

---

## 三、本次修复的实现载体

**重要前提（已三重独立验证）**：要修改的 uni-app-x 源码工程 `gwork-app` 不在本机——
- 探针硬编码工程根 `D:/work/gourd/gourdai/gourd-work-app/gwork-app`，本机无 D: 盘；
- 全 C 盘 `dir /s /b` 反查 `*.uvue` / `host.uts` / `pages.json`，零命中（仅 HBuilderX 模板与其他无关工程）；
- `gwork-android-release.apk` 是 uni-app-x 原生渲染产物，`www/` 只有 `manifest.json`/`logo.png`/`theme.css`，页面逻辑编译进 dex，无法反推可维护源码；
- 当前仓库 git 历史与全部会话 blobs 中均无 `.uvue` 快照。

因此本次按「路径 B」落地：在 `gourd-work-app/mobile/` 新建一套**零依赖、可静态托管、可直接验证**的实现，作为 UI 契约的可执行基准与移植来源。

```
gourd-work-app/mobile/
├── index.html                 # 单页壳：page-root / tabbar / scrim / drawer / sheet
├── css/
│   ├── theme.css              # 三态主题 token（浅色/深色/系统跟随）
│   └── app.css                # 全部组件样式
├── js/
│   ├── icons.js               # 内联 SVG 图标库（currentColor 继承主题）
│   ├── data.js                # UI 契约单一数据源（Tab/建议/卡片/设备/模型/主题）
│   └── app.js                 # 状态机：4 Tab 路由 + 两态输入 + 4 面板 + 主题持久化
├── assets/robot.png           # 从参考图 75 裁出并做边缘透明化的机器人插画
├── test/
│   ├── mobile-ui.test.js      # 36 项契约测试（数据/图标/D1–D10/实心图标/运行时行为/真实事件委托）
│   ├── interaction.cjs        # 36 项真实点击交互测试（4 Tab/4 面板开关/主题/输入/脏数据）
│   ├── action-audit.cjs       # data-action 与 ACTIONS 处理器一一对应审计（无死按钮）
│   └── probe.cjs              # Edge headless 390×844 13 场景：真实断言 + 深链 + 冒泡 + dispatch
└── .probe/                    # 探针产物：13 张截图 + metrics.json
```

### 验证结果（最终全量复跑，2026-11-07）
```
node gourd-work-app/mobile/test/mobile-ui.test.js   → 36/36 通过
node gourd-work-app/mobile/test/interaction.cjs     → 36/36 通过
node gourd-work-app/mobile/test/action-audit.cjs   → 24/24 一一对应（零死按钮）
node gourd-work-app/mobile/test/probe.cjs           → 13 场景 / 0 失败 / exitCode=0
node gourd-work-app/gwork-app/tests/integration-check.cjs → 40/40 通过
```
- 静态契约测试：数据契约、图标完整性、D1–D10 逐项回归、**选中 Tab 实心图标契约**、app.js 语法、无非法嵌套 button；新增 13 项**运行时行为断言**（vm DOM 桩真实调用 init/getState/dispatch/render，覆盖真实 DOM click、MouseEvent 冒泡、4 面板开关、三态主题、脏 localStorage 不白屏），并把 `action-audit.cjs` 与 `interaction.cjs` 的真实通过纳入契约。
- 真实点击交互测试：CDP 执行真实 DOM `click()`，覆盖 4 Tab 切换、首页两态输入与发送、4 个面板「打开/遮罩关闭/Esc 关闭」、主题三态实际背景色、触感开关、换一换、建议填入、脏 localStorage 白屏防御。
- 视觉探针 **13 场景**：`01-tasks-idle` / `02-tasks-focus` / `03-loop` / `04-discover` / `05-mine` / `06-drawer` / `07-devices` / `08-attach` / `09-models` / `10-dark` / `11-deeplink-loop` / `12-deeplink-mine` / `13-dispatch`。
  `probe.cjs` 已升级为**带真实断言**（rootH/rootBottom/tabTop/overflow/clipped/errors/tab/panel/theme/activeSolid 任一不符即 `exitCode=1`）、全部场景走**真实 DOM 点击 / MouseEvent 冒泡**（不再用 dispatch 绕过事件委托）、`finally`/`catch` 统一释放 CDP socket 与 Edge、动态端口避冲突。
  几何量测：**rootH=844、rootBottom=844、tabTop=768**（铺满且 Tab 固定）、浅色 `rgb(250,250,250)` / 深色 `rgb(20,20,22)`、**零横向溢出、零越界裁切、零控制台错误、零 404**、`activeSolid=1`（选中 Tab 实心图标）、深链 `#loop`/`#mine` 生效。截图已逐张与参考图 74–82 人工比对。

### 本轮修复过程中自查出的额外缺陷（一并修掉）
| 问题 | 修复 |
|---|---|
| `[hidden]` 被 `.sheet{display:flex}` 压过导致面板关不掉 | 加 `[hidden]{display:none!important}` 兜底 |
| 「换一换」被 flex stretch 拉成整行宽 | `align-self:flex-start` |
| 聚焦输入后机器人被裁、「换一换」被挤出视口 | `.is-focused` 收紧 hero 尺寸，4 胶囊+换一换始终完整 |
| 空态机器人图标只有 28px（外层 div 放大无效） | 直接放大内部 SVG 至 130px |
| 设备/模型行的青绿勾未靠最右、设备名被挤换行 | 设备行改 grid 三列固定布局；模型行保留 `.spacer{flex:1}` |
| favicon 404 | `<link rel="icon" href="data:,">` |
| 未聚焦输入态存在 `button` 内嵌可点击 `span`（非法语义、键盘不可聚焦） | 改为 div 容器 + 两个兄弟 button |
| 静态测试里存在一条恒真无效断言 | 换成真实结构断言 + 运行时行为契约 |
| 独立 code review 的 H2：`suggestionPage` 脏值（`"abc"`/`null`/`0.5`）令 `.map` 抛错白屏 | 改 `Number.isInteger` + 范围校验，并给 `renderTasksPage` 的 list 加兜底 |
| H1/H4：测试全是字符串包含，`dispatch` 绕过事件委托 | 契约测试加 13 项运行时行为断言；探针全部改真实 DOM click / MouseEvent 冒泡；`dispatch` 与 `onClick` 共用 `invoke()` |
| H3：探针零断言、异常路径泄漏 Edge/CDP socket | 加真实断言 + `exitCode=1`；`finally`/`catch` 统一释放；动态端口 |
| M1：重渲染强制光标置尾、`keepCaret` 死代码 | 渲染前保存 `selectionStart/End`，渲染后原样恢复；`resetCaret` 仅用于首次聚焦 |
| M2：聚焦态无退出路径、send 无禁用态 | Esc 退出聚焦回到图 75 单行胶囊；send 同步 `disabled`/`aria-disabled`/`is-ready` |
| M3：8 个动作是空桩、选设备无可见反馈 | 统一 `hostAction()` 记录 `lastAction` 并调用 `window.GWorkHost.*`；选设备后顶栏/抽屉文案与图标立即变化 |
| M4：品牌统一为 GWork 自有商标 | `BRAND` 逐字改为 `GWork` / `GWork，我帮你`，`<title>` 同步 |
| M5：选中 Tab 仍为线性图标 | 新增 4 个 `*Solid` 实心变体，`renderTabbar` 选中时渲染 `.tab-solid` |
| M6/M7/M8：无 safe-area、深色 token 重复、320px 溢出 | `env(safe-area-inset-*)` + `color-scheme` 同步；深色 token 单一数据源并补 `--danger-*`；320/360px 分档兜底 |
| L2/L3/L4/L7：深链失效、面板/焦点被持久化、`stopPropagation` 无效残留 | 冷启动解析 hash；瞬时 UI 态一律不恢复；属性统一 `esc()`；删除无效调用 |

---

## 四、用户所选方案 B 已落地：复用 uni-ai-x 的 uni-app-x 工程

用户拍板「B：授权新建一套 uni-app-x 工程（补充：可以直接复用 uni-ai-x 项目，你直接拉取相关源码，然后修改）」。
已实际拉取上游并改造出**可维护的原生工程源码**：

```
git clone --depth 1 --branch v3.1 https://gitcode.com/dcloud/uni-ai-x.git \
  gourd-work-app/vendor/uni-ai-x          # 干净上游副本（f9fc94b，394 文件，Apache-2.0）

gourd-work-app/gwork-app/                 # 可编译的 uni-app-x 工程（从上游复制，排除 .git）
├── pages.json                           # 4 个主页面 + 原生 tabBar（8 图标）+ 保留 3 个 uni-ai-x 对话页
├── App.uvue                             # 仅 initWorkbuddyTheme()；无任何启动配对门禁
├── common/workbuddy-data.uts            # 从 mobile/js/data.js 移植的 UI 契约（UTS 类型化）
├── common/workbuddy-theme.uts           # 三态主题 system/light/dark，浅色为默认观感
├── uni.scss / theme.json                # $gw-* 颜色 token，与 mobile/css/theme.css 对齐
├── pages/tasks|loop|discover|mine/*.uvue # 4 个按参考图自写的主页面
├── static/robot.png + static/tabbar/*.png
├── uni_modules/uni-ai-x/config.uts      # llmModelMap 对齐 8 个模型档位，默认 Hy3，无硬编码密钥
├── INTEGRATION.md                       # 上游来源/改动清单/复用边界/编译步骤/后端接入 TODO
├── tests/integration-check.cjs          # 40 项工程静态自检（node 直接跑）
└── README.md / license.md               # 保留上游 Apache-2.0
```

两套交付物**互补**：`mobile/` 是可运行、已逐页对照 9 张图验证的 UI 契约基准（也可作 `web-view` 载体）；
`gwork-app/` 是可编译出 Android/iOS/鸿蒙包的 uni-app-x 源码。二者共用同一份 UI 契约数据与配色 token。

`tests/integration-check.cjs` 实测 **40/40 通过**：pages.json 8 个页面路径全部有 `.uvue`、tabBar 8 个图标全部存在、
首个 page 为首页且无 `redirectTo/reLaunch` 门禁、主题模块导出存在、UTS 与 H5 品牌/主题/强调色一致、
4 页均为合规 `<script lang="uts" setup>` 且无 Vue2-only 写法、上游许可证保留、config.uts 8 档模型齐备且无密钥。

> **打包状态（2026-11-07 实测）**：`gwork-app/` 已用本机 `C:\Apps\HBuilderX\cli.exe`（5.34）完成导入、`pack --precheck`（errors=0）、8 页 + 全组件真实编译、Android 云打包并下载产物：
> `gourd-work-app/gwork-android-3.0.4.apk`（40,388,962 字节，appid `__UNI__2C8A727`，包名 `com.gourdai.gwork`，云端证书签名）。
> 真实命令、证书类型、appid 对齐原因与旧包边界见 `gwork-app/INTEGRATION.md` 第六节。

---

## 五、已知边界
- 静态数据（Blake / 3363.38 积分 / 设备列表 / 模型倍率）按参考图还原为展示值；业务接口通过 `hostAction()` 统一交给 `window.GWorkHost.*` 宿主注入（H5 侧），uni-app-x 侧对应 `.uvue` 页留了明确 TODO，均未接真实后端。
- 品牌文案为 **GWork** 自有商标（布局仍对照 WorkBuddy 参考图）（`GWork` / `GWork，我帮你`）；改品牌只动这两处 `BRAND` 与 `mobile/assets/gwork-logo.png` / `gwork-app/static/gwork-logo.png`（与桌面 UI `/img/favicon.png` 同源）。
- 主题「系统」态：H5 依赖 `prefers-color-scheme`；uni-app-x 侧由 `uni.getSystemInfo` / `onAppThemeChange` / `setAppTheme` 承接。
- uni-ai-x 的流式对话、Markdown 原生渲染、多轮会话等能力已作为接入点保留，但 `pages/tasks/tasks.uvue` 的 `onSend` 目前仍是 toast 占位，接后端时改为 `UniAi.answerQuestion(...)` 或跳 `uni_modules/uni-ai-x/pages/index/index`。
