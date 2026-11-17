import { computed, ref, watch } from 'vue'
import type { ComputedRef } from 'vue'
import { setTheme as setRiceUiTheme } from '@/uni_modules/rice-ui'

/**
 * 全局主题统一入口，一次 setThemeMode 同时驱动：
 * APP 端 uni.setAppTheme（uni-ai-x 等媒体查询组件自动跟随）、rice-ui setTheme（其 store
 * 默认恒 light，必须由这里桥接）与自有页面的 themeClass。
 */

/** 用户选择的主题模式：亮色 / 暗黑 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'auto'

const STORAGE_KEY = 'gwork_theme_mode'

const themeMode = ref<ThemeMode>('auto')
// 系统当前是否深色，只有 auto 模式参与计算
const systemDark = ref<boolean>(false)

let initialized = false

/** 当前用户偏好，含 auto；用于设置页回显选中项 */
export const currentMode = computed<ThemeMode>((): ThemeMode => themeMode.value)

/** 实际生效的主题，auto 已解析为具体值 */
export const isDark = computed<boolean>((): boolean => {
	if (themeMode.value === 'auto') return systemDark.value
	return themeMode.value === 'dark'
})

/** 页面/组件根节点绑定的主题类，避免各处重复书写类名字面量 */
export const themeClass = computed<string>((): string => isDark.value ? 'theme-dark' : 'theme-light')

function normalizeMode(value: string | null): ThemeMode {
	if (value === 'light' || value === 'dark') return value
	return 'auto'
}

function readSystemTheme(): void {
	uni.getSystemInfo({
		success: (res: GetSystemInfoResult) => {
			// #ifdef APP
			systemDark.value = res.osTheme === 'dark'
			// #endif
			// #ifdef WEB || MP
			systemDark.value = res.hostTheme === 'dark'
			// #endif
		}
	})
}

function readStoredMode(): ThemeMode {
	const stored = uni.getStorageSync(STORAGE_KEY)
	return normalizeMode(typeof stored === 'string' ? stored : null)
}

function syncRiceUi(): void {
	setRiceUiTheme(isDark.value ? 'dark' : 'light')
}

function dispatch(mode: ThemeMode): void {
	themeMode.value = mode
	// #ifdef APP
	uni.setAppTheme({
		theme: mode,
		fail: (err: IAppThemeFail) => {
			console.error('[theme] setAppTheme 失败', err.errMsg)
		}
	})
	// #endif
	// WEB / 小程序没有 setAppTheme，强制亮暗只作用于自有页面与 rice-ui；
	// uni-ai-x 的 CSS 变量在 Web 端跟随浏览器偏好，属于平台能力限制。
	// rice-ui 同步由 initTheme 里的 watch(isDark) 统一处理，这里不重复调。
}

/** 切换主题模式并持久化 */
export function setThemeMode(mode: ThemeMode): void {
	if (themeMode.value === mode) return
	dispatch(mode)
	uni.setStorageSync(STORAGE_KEY, mode)
}

/** 应用启动时调用一次，恢复上次选择并注册系统主题监听 */
export function initTheme(): void {
	if (initialized) return
	initialized = true
	readSystemTheme()
	// 先注册再 dispatch：readSystemTheme 是异步回调，auto 模式下系统深浅色晚于首帧到达时，
	// 靠这个 watch 把 rice-ui 重新同步到已解析的结果（themeClass 本身是响应式，页面无需额外处理）
	watch(isDark, (): void => {
		syncRiceUi()
	})
	dispatch(readStoredMode())
	// #ifdef APP
	uni.onAppThemeChange((res: AppThemeChangeResult) => {
		// 其他调用方（如 uni-ai-x 自带设置页）改动 appTheme 时以系统值为准，避免两处状态分裂
		if (res.appTheme != null) {
			const next = normalizeMode(res.appTheme)
			if (next !== themeMode.value) {
				themeMode.value = next
				uni.setStorageSync(STORAGE_KEY, next)
			}
		}
		readSystemTheme()
	})
	// #endif
	// #ifdef WEB || MP
	uni.onHostThemeChange((res: OnHostThemeChangeCallbackResult) => {
		systemDark.value = res.hostTheme === 'dark'
	})
	// #endif
}

/**
 * 组件内使用：
 *   const { themeClass, isDark, currentMode, setThemeMode } = useTheme()
 * 状态是模块级单例，多处调用共享同一份，无需 provide / inject。
 */
export type ThemeApi = {
	themeClass: ComputedRef<string>
	isDark: ComputedRef<boolean>
	currentMode: ComputedRef<ThemeMode>
	setThemeMode: (mode: ThemeMode) => void
}

export function useTheme(): ThemeApi {
	return {
		themeClass,
		isDark,
		currentMode,
		setThemeMode
	}
}
