# gwork-speech 系统语音识别（零三方 SDK）

按住实时语音识别 UTS 插件，三端全部走系统原生 ASR，不引入任何第三方 SDK / 云端密钥：

| 端 | 引擎 | 数据去向 |
| --- | --- | --- |
| Android | `android.speech.SpeechRecognizer`（Kotlin 混编） | 取决于厂商预装引擎（可能联网） |
| iOS | `Speech.framework SFSpeechRecognizer`（Swift 混编） | 支持端侧的语言优先端侧，否则走苹果服务器 |
| 鸿蒙 | `@kit.CoreSpeechKit speechRecognizer` + `AudioCapturer` | 纯端侧离线，不出设备 |
| Web / 小程序 | 不支持（业务层 `isSpeechSupported()` 恒 false，本插件不参与非 APP 编译） | — |

业务层约定：`isSpeechSupported()`（utils/speech-recognizer.uts）为 false 时**整体隐藏语音入口**
（麦克风按钮 / 长按直录），而不是点击后报错。运行时 `unsupported` 终态（鸿蒙非大陆机型等）
落缓存后入口即时隐藏；缓存按应用语言失效（鸿蒙仅中文，切语言重新探测）。

## API

**接入规范（经真机编译验证，违反任一条都会编译失败）：**

1. 宿主文件必须是 `.uts` 或 `.uvue`（不能 `.ts`）。蒸汽模式下只有参与 UTS 编译的宿主
   才会把插件注册进 Kotlin/Swift 原生编译管线；`.ts` 宿主会让插件按普通 JS 模块
   走 uts2js，报 `[plugin:uts] Could not resolve "android.content.Context"`。
2. 从**插件根目录** import（`@/uni_modules/gwork-speech`），由编译器按平台自动解析到
   `utssdk/app-*/index.uts` 并注册原生编译（与官方 uts-openSchema 插件同构）。
   **不要**带 `utssdk/app-android/index.uts` 完整路径——vite 的 `resolveUTSAppModule`
   只认父目录为 `uni_modules`/`utssdk` 的模块 id，深层路径不走 UTS 代理，同样报上述错误。
   （例外：worker `.uts` 内的深层路径 import 走独立的 worker 编译管线，如 uni-ai-x 的用法。）
3. **不要**建插件根 `index.uts` 转发入口（非标准结构，干扰平台解析）。
4. 块注释里不要出现 `*/` 字样（如 glob `app-*/index.uts` 会提前终止注释导致语法错误）。

```ts
// #ifdef APP
import { isSpeechAvailable, startListening, stopListening, cancelListening } from '@/uni_modules/gwork-speech'
// #endif
// 类型：Android/鸿蒙从 interface.uts import；iOS 从平台入口 import（JS 引擎环境类型须内联）

startListening({
	language: 'zh-CN',        // BCP-47；鸿蒙端仅支持 zh-CN
	maxDurationMs: 60000,     // 到时自动收尾
	onPartial: (text) => {},  // 中间结果，全量替换语义
	onResult: (text) => {},   // 终态：最终文本（空串 = 没听清）
	onError: (err) => {}      // 终态：{ code, detail }，code 见 interface.uts
})
stopListening()   // 松手收尾，等最终结果（内部 3s 兜底）
cancelListening() // 静默放弃，不派发回调
```

每个会话 `onResult` / `onError` 至多派发一次；会话进行中重复 `startListening` 回调 `busy`。

## 平台配置与约束

- **Android**：`RECORD_AUDIO` 由插件内 `UTSAndroid.requestSystemPermission` 动态申请；
  插件 AndroidManifest 已带 `<queries>`（Android 11+ 包可见性，缺失则找不到厂商引擎）。
  无预装识别引擎的设备 `isSpeechAvailable(language)` 为 false（华为无 GMS 老机型常见）。
  三端 `isSpeechAvailable(language: string)` 的 language 为 BCP-47 标签，由业务层按应用语言传入
  （uni.getLocale 在 uni-app x 蒸汽模式不存在，插件不自行取语言；Android 端忽略该参数）。
- **iOS**：项目根 `Info.plist` 需含 `NSMicrophoneUsageDescription` 与 `NSSpeechRecognitionUsageDescription`
  （本项目已配置）。识别 + 麦克风双权限弹窗由插件按序拉起。苹果对非端侧识别有设备级配额限制。
- **鸿蒙**：仅中文普通话、仅中国大陆机型（Phone/Tablet/2in1）；`ohos.permission.MICROPHONE`
  在插件 module.json5 声明并运行时申请；引擎同进程单例，会话终结即 `shutdown()` 释放。
  API 11（HarmonyOS 4.1.0）起可用；API 20 之前的模拟器不支持，需真机验证。

## 生效条件（重要）

含原生代码与 manifest 变更，**必须重新制作自定义调试基座**（或云打包正式包）后真机运行；
标准基座里没有本插件，`import` 会失败。iOS / 鸿蒙同理需各自的自定义基座。

## 目录

```
package.json                # uni_modules 清单：dcloudext.type=uts + vapor√ + uni-app-x 三端√
utssdk/
├── interface.uts           # 跨端接口与统一错误码（Android/鸿蒙 import；iOS 需在平台入口内联同款类型）
├── app-android/index.uts   # UTS 入口（权限申请 + 转发）
├── app-android/GworkSpeechSession.kt  # 原生混编会话（主线程 Handler / RecognitionListener / Long extra）
├── app-android/AndroidManifest.xml
├── app-ios/index.uts       # UTS 入口（转发）
├── app-ios/GworkSpeechEngine.swift  # 原生混编引擎（权限/采集/识别）
├── app-ios/config.json     # Speech.framework / AVFoundation.framework
├── app-harmony/index.uts   # CoreSpeechKit + AudioCapturer（16k/mono/16bit PCM）
├── app-harmony/module.json5
└── app-harmony/resources/base/element/string.json
```