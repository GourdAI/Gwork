import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'

/**
 * 视口统一入口：横屏 / 平板 / 分屏的响应式布局全部从这里取数，业务代码不直接读 uni.getWindowInfo。
 * 模块级单例 + App.uvue onLaunch 调 initViewport()，与 useTheme 同一套模式。
 *
 * 为什么不用 CSS 媒体查询：UCSS 的尺寸媒体查询在原生端不可靠，且项目样式一律由
 * JS 状态驱动类名 / 行内样式（AGENTS.md 9.3），四端行为才一致。
 */

/** 宽屏阈值：>= 700 视为平板 / 横屏手机，首页切换为「会话抽屉常驻 + 主区」双栏 */
export const WIDE_MIN_WIDTH = 700
/** 表单 / 设置类内容列宽上限：超过后居中成单列，不再横向铺满 */
export const FORM_COLUMN_WIDTH = 520
/** 弹层（底部 sheet / action-sheet）宽度上限 */
export const SHEET_MAX_WIDTH = 560
/** 双栏侧栏宽度：随视口伸缩并封顶 */
export const SIDEBAR_MIN_WIDTH = 280
export const SIDEBAR_MAX_WIDTH = 360
/** 窄屏浮层抽屉宽度：视口的 86%，右侧留缝露出主页面（对齐 workbuddy 抽屉形态） */
export const DRAWER_WIDTH_RATIO = 0.86
export const DRAWER_MAX_WIDTH = 420

const windowWidth: Ref<number> = ref<number>(0)
const windowHeight: Ref<number> = ref<number>(0)
const safeBottom: Ref<number> = ref<number>(0)
const safeLeft: Ref<number> = ref<number>(0)
const safeRight: Ref<number> = ref<number>(0)

let initialized = false

/** 宽屏（平板 / 横屏手机 / 桌面 Web 宽窗口） */
export const isWide = computed<boolean>((): boolean => windowWidth.value >= WIDE_MIN_WIDTH)

/** 横屏：宽大于高。矮屏留白压缩等场景与 isWide 区分（窄平板竖屏是宽屏但不横屏） */
export const isLandscape = computed<boolean>((): boolean => windowWidth.value > windowHeight.value)

/** 矮视口：横屏手机 / 分屏下半屏，固定大留白会溢出，需要压缩或改滚动 */
export const isShort = computed<boolean>((): boolean => windowHeight.value > 0 && windowHeight.value < 560)

/** 聊天列宽度上限：宽屏下消息流不无限拉宽（比表单列宽一档，容纳代码块） */
export const CHAT_COLUMN_WIDTH = 760

/** 聊天/输入列样式：在主区内限宽居中。用计算 margin-left 而非 align-self，
	list-view 的 list-item 内 align-self 不可靠，margin 四端行为一致 */
export const chatColumnStyle = computed<string>((): string => {
	if (!isWide.value) return ''
	const col: number = Math.min(CHAT_COLUMN_WIDTH, paneWidth.value - 24)
	const margin: number = Math.round((paneWidth.value - col) / 2)
	return 'width:' + col.toString() + 'px;margin-left:' + margin.toString() + 'px;'
})

/** 弹层外壳行内样式（rice-popup / rice-action-sheet 的 customStyle）：
	宽屏限宽居中 + 高度上限（横屏手机/分屏矮视口不顶穿屏幕），窄屏只限高保持全宽 */
export const sheetShellStyle = computed<UTSJSONObject>((): UTSJSONObject => {
	const style: UTSJSONObject = {}
	style['max-height'] = Math.round(windowHeight.value * 0.85).toString() + 'px'
	if (isWide.value) {
		const width: number = Math.min(SHEET_MAX_WIDTH, windowWidth.value - 48)
		style['width'] = width.toString() + 'px'
		style['margin-left'] = Math.round((windowWidth.value - width) / 2).toString() + 'px'
	}
	return style
})

/** 双栏侧栏宽度：视口的 30%，夹在 280~360 之间 */
export const sidebarWidth = computed<number>((): number => {
	const raw: number = Math.round(windowWidth.value * 0.3)
	return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, raw))
})

/** 窄屏浮层抽屉宽度：86% 视口宽、封顶 420，右侧留缝可点遮罩关闭 */
export const drawerWidth = computed<number>((): number => {
	return Math.min(DRAWER_MAX_WIDTH, Math.round(windowWidth.value * DRAWER_WIDTH_RATIO))
})

/** 主区可用宽度：宽屏双栏下 = 视口 - 侧栏 - 分隔线；窄屏即整窗 */
export const paneWidth = computed<number>((): number => {
	if (!isWide.value) return windowWidth.value
	return windowWidth.value - sidebarWidth.value - 1
})

/** 表单/设置列样式：宽屏限宽 + 计算 margin 居中（list/scroll 容器内 align-self 不可靠）。
 * inset 为容器左右 padding 之和，列宽夹住实际可用宽度，分屏小窗不溢出 */
export function formColumn(inset: number): string {
	if (!isWide.value) return ''
	const avail: number = windowWidth.value - inset
	const col: number = Math.min(FORM_COLUMN_WIDTH, avail)
	const margin: number = Math.round((avail - col) / 2)
	return 'width:' + col.toString() + 'px;margin-left:' + margin.toString() + 'px;'
}

/** 无内边距容器的默认表单列样式 */
export const formColumnStyle = computed<string>((): string => formColumn(0))

function readWindow(): void {
	const info = uni.getWindowInfo()
	windowWidth.value = info.windowWidth
	windowHeight.value = info.windowHeight
	safeBottom.value = info.safeAreaInsets.bottom
	safeLeft.value = info.safeAreaInsets.left
	safeRight.value = info.safeAreaInsets.right
}

/** 页面 onResize 生命周期入口（APP 端旋转/分屏只有页面级事件，见下） */
export function refreshViewport(): void {
	readWindow()
}

/** App.uvue onLaunch 调一次：初始化尺寸并注册窗口变化监听。
 *  平台差异（uni-app x 文档 api/window）：uni.onWindowResize 仅 Web/微信可用，
 *  APP 端没有全局监听，旋转/分屏靠各页面 onResize 调 refreshViewport()，
 *  onShow 再兜底重读一次（覆盖后台期间发生的旋转）。 */
export function initViewport(): void {
	if (initialized) return
	initialized = true
	readWindow()
	// #ifdef WEB || MP-WEIXIN
	uni.onWindowResize((_res: UniNamespace.WindowResizeResult): void => {
		// 回调里的 size 不含安全区，统一重读 getWindowInfo 保证各值同源
		readWindow()
	})
	// #endif
}

export type ViewportApi = {
	windowWidth: ComputedRef<number>
	windowHeight: ComputedRef<number>
	safeBottom: ComputedRef<number>
	safeLeft: ComputedRef<number>
	safeRight: ComputedRef<number>
	isWide: ComputedRef<boolean>
	isLandscape: ComputedRef<boolean>
	isShort: ComputedRef<boolean>
	formColumnStyle: ComputedRef<string>
	chatColumnStyle: ComputedRef<string>
	sheetShellStyle: ComputedRef<UTSJSONObject>
	sidebarWidth: ComputedRef<number>
	drawerWidth: ComputedRef<number>
	paneWidth: ComputedRef<number>
}

/** 只读视图（ref 以 ComputedRef 暴露，防止业务侧改写全局尺寸） */
const widthView = computed<number>((): number => windowWidth.value)
const heightView = computed<number>((): number => windowHeight.value)
const safeBottomView = computed<number>((): number => safeBottom.value)
const safeLeftView = computed<number>((): number => safeLeft.value)
const safeRightView = computed<number>((): number => safeRight.value)

export function useViewport(): ViewportApi {
	return {
		windowWidth: widthView,
		windowHeight: heightView,
		safeBottom: safeBottomView,
		safeLeft: safeLeftView,
		safeRight: safeRightView,
		isWide,
		isLandscape,
		isShort,
		formColumnStyle,
		chatColumnStyle,
		sheetShellStyle,
		sidebarWidth,
		drawerWidth,
		paneWidth
	}
}