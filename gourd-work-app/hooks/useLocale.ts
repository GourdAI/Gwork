/**
 * 语言切换统一入口：词条在 locale/ 十二个 json 中，切换即时生效（页面模板里的 t() 响应 locale ref）。
 * 语言集与桌面端对齐（zh-Hans/zh-Hant/en/de/ja/ru/el/es/fr/pt/ro/vi）。
 * 模块级单例，与 useTheme 同一模式；App.uvue onLaunch 调 initLocale() 恢复上次选择。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { i18n } from '@/locale/i18n.ts'

export type Locale = 'zh-Hans' | 'zh-Hant' | 'en' | 'de' | 'ja' | 'ru' | 'el' | 'es' | 'fr' | 'pt' | 'ro' | 'vi'

const STORAGE_KEY = 'gwork_locale'
const DEFAULT_LOCALE: Locale = 'zh-Hans'
const LOCALES: Locale[] = ['zh-Hans', 'zh-Hant', 'en', 'de', 'ja', 'ru', 'el', 'es', 'fr', 'pt', 'ro', 'vi']

const locale = ref<Locale>(DEFAULT_LOCALE)

let initialized = false

function normalize(value: unknown): Locale {
	const key: string = typeof value === 'string' ? value : ''
	return LOCALES.find((item: Locale): boolean => item === key) ?? DEFAULT_LOCALE
}

/** 切换语言并持久化 */
export function setLocale(next: Locale): void {
	locale.value = next
	i18n.global.locale.value = next
	uni.setStorageSync(STORAGE_KEY, next)
}

/** 应用启动时调用一次，恢复上次选择 */
export function initLocale(): void {
	if (initialized) return
	initialized = true
	setLocale(normalize(uni.getStorageSync(STORAGE_KEY)))
}

export type LocaleApi = {
	currentLocale: Ref<Locale>
	setLocale: (next: Locale) => void
}

export function useLocale(): LocaleApi {
	return {
		currentLocale: locale,
		setLocale
	}
}
