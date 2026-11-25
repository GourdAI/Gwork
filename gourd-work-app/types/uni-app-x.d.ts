/**
 * uni-app x 运行时全局声明（仅服务 `npm run type-check`）。
 *
 * 为什么需要它：项目是 uni-app x（.uvue / .uts）工程，`uni` 对象与 UTSJSONObject 等全局符号
 * 由 HBuilderX 编译器注入，TypeScript 编译器看不到，于是 `tsc --noEmit` 会对每一处
 * `uni.xxx` 报 TS2304「Cannot find name 'uni'」。这类噪声有 200+ 条，会把真正的类型错误
 * 淹没，使 type-check 失去门禁意义（历史遗留的 254 条基线即由此产生）。
 *
 * 声明范围只覆盖**本项目实际用到**的 API（见下方清单），方法签名按 uni-app x 文档写，
 * 不是 `any` 兜底：参数写错、返回值用错仍会被 tsc 抓到。新增 uni API 时在此补充声明，
 * 不要图省事改成 `declare const uni: any`。
 *
 * 用到的 API 清单（改代码时如新增，请同步维护）：
 *   存储 getStorageSync / setStorageSync / removeStorageSync
 *   请求 request、WebSocket connectSocket
 *   界面 showToast / showModal / getElementById / loadFontFace / exit
 *   路由 navigateTo / navigateBack / reLaunch / chooseImage
 *   主题 getSystemInfo / setAppTheme / onAppThemeChange / onHostThemeChange
 *   窗口 getWindowInfo / onWindowResize
 */

/** UTS 对象类型：uni-app x 里对应 UTSJSONObject，值类型不限 */
declare type UTSJSONObject = Record<string, any>

/** 编译器注入的开发态常量（HBuilderX/Vite define）：release 构建为 false。
 *  与 uni 同理，tsc 看不到注入，需在此声明（useConversations 未知帧护栏用）。 */
declare const __DEV__: boolean

/** uni.getSystemInfo 结果（本项目只读主题相关字段） */
declare interface GetSystemInfoResult {
	osTheme?: string | null
	hostTheme?: string | null
	platform?: string
	[k: string]: any
}

/** uni.setAppTheme 失败回调参数 */
declare interface IAppThemeFail {
	errMsg: string
	[k: string]: any
}

/** uni.onAppThemeChange 回调参数（APP 端） */
declare interface AppThemeChangeResult {
	appTheme?: string | null
	[k: string]: any
}

/** uni.onHostThemeChange 回调参数（Web / 小程序端） */
declare interface OnHostThemeChangeCallbackResult {
	hostTheme?: string | null
	[k: string]: any
}

declare namespace UniNamespace {
	/** uni.onWindowResize 回调参数（不含安全区，安全区一律走 getWindowInfo） */
	interface WindowResizeResult {
		size?: { windowWidth: number; windowHeight: number }
		[k: string]: any
	}
}

/** uni.request 成功响应：data 为后端响应体，类型不确定 */
declare interface UniRequestSuccess {
	data: any
	statusCode: number
	header?: Record<string, string>
	cookies?: string[]
	errMsg?: string
	[k: string]: any
}

/** uni.request 返回的任务对象（可 abort / 监听响应头） */
declare interface UniRequestTask {
	abort(): void
	onHeadersReceived(callback: (res: { header: Record<string, string> }) => void): void
	offHeadersReceived(callback?: (res: { header: Record<string, string> }) => void): void
}

/**
 * uni.request 入参。`[key: string]: any` 保留平台扩展参数（如 sslVerify、withCredentials），
 * 这也是 utils/request.ts 用 `Parameters<typeof uni.request>[0]` 反推类型的前提。
 */
declare interface UniRequestOptions {
	url?: string
	method?: string
	data?: any
	header?: Record<string, string>
	timeout?: number
	sslVerify?: boolean
	withCredentials?: boolean
	success?: (res: UniRequestSuccess) => void
	fail?: (err: any) => void
	complete?: (res: any) => void
	[k: string]: any
}

/** uni.connectSocket 的返回（WS 任务） */
declare interface UniSocketTask {
	send(options: {
		data: string | ArrayBuffer
		success?: (res: any) => void
		fail?: (err: any) => void
		complete?: (res: any) => void
	}): void
	close(options?: {
		code?: number
		reason?: string
		success?: (res: any) => void
		fail?: (err: any) => void
		complete?: (res: any) => void
	}): void
	onOpen(callback: (res: any) => void): void
	onClose(callback: (res: any) => void): void
	onError(callback: (err: any) => void): void
	onMessage(callback: (res: { data: string | ArrayBuffer }) => void): void
}

declare interface UniConnectSocketOptions {
	url?: string
	multiple?: boolean
	protocols?: string[]
	success?: (res: any) => void
	fail?: (err: any) => void
	complete?: (res: any) => void
	[k: string]: any
}

/** uni.getFileSystemManager()（附件 base64 读取，utils/attach-picker.ts） */
declare interface UniFileSystemManager {
	readFile(options: { filePath: string; encoding?: string; success?: (res: { data: string | ArrayBuffer }) => void; fail?: (err: { errMsg: string }) => void; complete?: (res: any) => void }): void
	[k: string]: any
}

/** 窗口信息（尺寸 + 安全区），见 hooks/useViewport.ts */
declare interface UniWindowInfo {
	windowWidth: number
	windowHeight: number
	screenWidth: number
	screenHeight: number
	safeAreaInsets: { top: number; bottom: number; left: number; right: number }
	pixelRatio?: number
	[k: string]: any
}

declare interface UniShowToastOptions {
	title: string
	icon?: string
	duration?: number
	position?: string
	mask?: boolean
	success?: (res: any) => void
	fail?: (err: any) => void
	complete?: (res: any) => void
	[k: string]: any
}

declare interface UniNavigateOptions {
	url: string
	[k: string]: any
}

/** uni.showModal success 回调参数（confirm=true 点了确认，cancel=true 点了取消） */
declare interface ShowModalSuccess {
	confirm: boolean
	cancel: boolean
	[k: string]: any
}

declare interface UniShowModalOptions {
	title?: string
	content?: string
	showCancel?: boolean
	cancelText?: string
	confirmText?: string
	success?: (res: ShowModalSuccess) => void
	fail?: (err: any) => void
	complete?: (res: any) => void
	[k: string]: any
}

/** textarea/input 的 keyboardheightchange 事件（height 单位 px，收起时为 0） */
declare interface UniInputKeyboardHeightChangeEvent {
	detail: { height: number; duration?: number }
	[k: string]: any
}

/** uni 全局对象：只声明本项目用到的方法，签名按官方文档 */
declare const uni: {
	getStorageSync(key: string): any
	setStorageSync(key: string, data: any): void
	removeStorageSync(key: string): void

	request(options: UniRequestOptions): UniRequestTask
	connectSocket(options: UniConnectSocketOptions): UniSocketTask

	showToast(options: UniShowToastOptions): void
	showModal(options: UniShowModalOptions): void
	getElementById(id: string): any
	loadFontFace(options: { family: string; source: string; desc?: any; global?: boolean; [k: string]: any }): void
	exit(options?: { success?: (res: any) => void; fail?: (err: any) => void; complete?: (res: any) => void }): void

	navigateTo(options: UniNavigateOptions): void
	navigateBack(options?: { delta?: number; [k: string]: any }): void
	reLaunch(options: UniNavigateOptions): void
	chooseImage(options?: { count?: number; sizeType?: string[]; sourceType?: string[]; [k: string]: any }): void
	previewImage(options: { urls: string[]; current?: number | string; [k: string]: any }): void
	/** 附件链路（utils/attach-picker.ts）：系统文件选择器，tempFiles 带 path/name/size */
	chooseFile(options: { count?: number; type?: string; extension?: string[]; success?: (res: { tempFilePaths: string[]; tempFiles: any[] }) => void; fail?: (err: any) => void; complete?: (res: any) => void; [k: string]: any }): void
	compressImage(options: { src: string; quality?: number; compressedWidth?: number; compressedHeight?: number; success?: (res: { tempFilePath: string }) => void; fail?: (err: any) => void; complete?: (res: any) => void; [k: string]: any }): void
	getFileSystemManager(): UniFileSystemManager
	arrayBufferToBase64(buffer: ArrayBuffer): string
	setClipboardData(options: { data: string; showToast?: boolean; success?: (res: any) => void; fail?: (err: any) => void; complete?: (res: any) => void; [k: string]: any }): void

	getSystemInfo(options: {
		success?: (res: GetSystemInfoResult) => void
		fail?: (err: any) => void
		complete?: (res: any) => void
	}): void
	setAppTheme(options: {
		theme: string
		success?: (res: any) => void
		fail?: (err: IAppThemeFail) => void
		complete?: (res: any) => void
	}): void
	onAppThemeChange(callback: (res: AppThemeChangeResult) => void): void
	onHostThemeChange(callback: (res: OnHostThemeChangeCallbackResult) => void): void

	getWindowInfo(): UniWindowInfo
	onWindowResize(callback: (res: UniNamespace.WindowResizeResult) => void): void
}

/** rich-text @itemclick 事件（App 端 mode="native"；detail.href 链接、detail.src 图片） */
declare interface UniRichTextItemClickEvent {
	detail: { href?: string | null; src?: string | null; [k: string]: any }
	[k: string]: any
}

/** .uvue 单文件组件：由 HBuilderX 编译，tsc 无法解析，统一按任意组件处理 */
declare module '*.uvue' {
	const component: any
	export default component
}

/**
 * 自研纯 UTS markdown 解析器（utils/markdown-parse.uts，全平台零原生依赖）。
 * tsc 不解析 .uts，对外契约在此声明；行为断言见 build/verify-mobile-fixes.cjs。
 * stable=false 是流式未收口尾块（下一帧整体替换）；纯追加流式下稳定块内容/序号恒定。
 */
declare module '@/utils/markdown-parse.uts' {
	export type MdBlock = { html: string; stable: boolean }
	export function parseMarkdownBlocks(text: string, complete: boolean): MdBlock[]
}

/** rice-ui 插件（.uts 入口，tsc 不解析 .uts） */
declare module '@/uni_modules/rice-ui' {
	export function setTheme(mode: string): void
}
