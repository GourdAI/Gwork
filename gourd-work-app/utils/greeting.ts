import { i18n } from '@/locale/i18n.ts'

/**
 * 首页欢迎语抽取：对齐桌面端 app.welcome_greeting.0~19 的随机轮换
 * （词条移植为 home.greeting.0~19，见 build/brand/apply-greetings.cjs）。
 *
 * 状态必须放模块级而不是组件 <script setup> 里：setup 作用域每次挂载重建，
 * 「排除上一条」会随重建失效；hero 随新建会话/冷启动反复挂载，跨挂载去重靠这里。
 */
const GREETING_COUNT = 20

let lastIndex = -1

/** 抽一条欢迎语索引；与上一条相同时顺延，避免连续重复（同桌面端 pickWelcomeTitle(exclude)） */
export function pickGreetingIndex(): number {
	let next = Math.floor(Math.random() * GREETING_COUNT)
	if (next === lastIndex) next = (next + 1) % GREETING_COUNT
	lastIndex = next
	return next
}

/** 索引 → 当前语言词条（locale 切换时由调用方的 computed 重新求值） */
export function greetingText(index: number): string {
	return i18n.global.t('home.greeting.' + index)
}