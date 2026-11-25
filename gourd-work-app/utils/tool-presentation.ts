/**
 * 工具展示模型（PC app-tool-presentation.js 的移动端等价物）。
 *
 * 用户报障「移动端图标等和 PC 不一致」的根因：移动端所有工具共用一个齿轮
 * rice-icon + 裸英文工具名。这里移植 PC 的三件套：
 *  1) TOOL_I18N_KEY：注册名（含别名族）→ chat.tool_* 本地化键；
 *  2) toolIconSvg：17 类工具专属线性 SVG（与 PC TOOL_ICON 逐字同源）+ 扳手兜底；
 *  3) resolveToolLabel：裸名提取 + 本地化 + bash「终端命令」名词覆盖。
 *
 * SVG 渲染：uni-app x 的 image 支持 data-uri SVG（app-md-text 公式渲染同款），
 * currentColor 在 data-uri 里不继承页面色，故按主题把 stroke 替换成具体灰阶
 * （亮色 #6b7280 ≈ --text-tertiary，暗色 #9ca3af），运行中由 UI 层换 accent 色。
 * 缓存 per-(工具×主题) 的 data-uri，避免每帧重编码。
 */
import { i18n } from '@/locale/i18n.ts'

/* 与 PC TOOL_I18N_KEY 逐字同表（含别名归并）：漏一个就退化裸英文名 */
const TOOL_I18N_KEY: Map<string, string> = new Map<string, string>([
	['read', 'chat.tool_read'], ['write', 'chat.tool_write'], ['edit', 'chat.tool_edit'],
	['glob', 'chat.tool_glob'], ['grep', 'chat.tool_grep'], ['ls', 'chat.tool_ls'],
	['bash', 'chat.tool_bash'], ['bash_output', 'chat.tool_bash_output'],
	['skill', 'chat.tool_skill'], ['skilllist', 'chat.tool_skill'], ['skillsearch', 'chat.tool_skill'],
	['skillread', 'chat.tool_skill'], ['skillrefresh', 'chat.tool_skill'],
	['todo', 'chat.tool_todo'], ['todowrite', 'chat.tool_todo'], ['todoread', 'chat.tool_todo'],
	['code', 'chat.tool_code'], ['codesearch', 'chat.tool_codesearch'],
	['websearch', 'chat.tool_websearch'], ['web_search', 'chat.tool_websearch'],
	['webfetch', 'chat.tool_webfetch'], ['crawl_url', 'chat.tool_webfetch'],
	['task', 'chat.tool_task'], ['multitask', 'chat.tool_multitask'], ['await_tasks', 'chat.tool_task'],
	['generate', 'chat.tool_generate'],
	['mcp', 'chat.tool_mcp'], ['list_mcp_tools', 'chat.tool_mcp'], ['search_tools', 'chat.tool_mcp'],
	['get_tool_detail', 'chat.tool_mcp'], ['call_tool', 'chat.tool_mcp'],
	['openapi', 'chat.tool_openapi'], ['search_apis', 'chat.tool_openapi'],
	['get_api_detail', 'chat.tool_openapi'], ['call_api', 'chat.tool_openapi'],
	['lsp', 'chat.tool_lsp'],
	['memory', 'chat.tool_memory'], ['memory_extract', 'chat.tool_memory'], ['memory_search', 'chat.tool_memory'],
	['memory_recall', 'chat.tool_memory'], ['memory_consolidate', 'chat.tool_memory'], ['memory_prune', 'chat.tool_memory'],
	['recall_history', 'chat.tool_recall'],
	['ask_user', 'chat.tool_ask_user'],
	['add_model', 'chat.tool_config'], ['add_mcp_server', 'chat.tool_config'], ['add_api_server', 'chat.tool_config'],
	['now', 'chat.tool_clock'],
	['create_plan', 'chat.tool_plan'], ['update_plan_progress', 'chat.tool_plan_progress'], ['revise_plan', 'chat.tool_plan_revise']
])

/* 与 PC TOOL_ICON 逐字同源的 16×16 线性 SVG（stroke=currentColor 占位，渲染时替换） */
const TOOL_ICON: Map<string, string> = new Map<string, string>([
	['edit', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 11.8-.6 2.1 2.1-.6L12.8 5a1.6 1.6 0 0 0-2.3-2.3L2.2 11.1Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="m9.5 3.5 3 3" stroke="currentColor" stroke-width="1.2"/></svg>'],
	['write', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 1.8h6l4 4v8.4H3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.8v4h4M5 9h6M5 11.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'],
	['read', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 3.2A5.5 5.5 0 0 1 8 4.8a5.5 5.5 0 0 1 5.5-1.6v9.6A5.5 5.5 0 0 0 8 14.4a5.5 5.5 0 0 0-5.5-1.6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 4.8v9.6" stroke="currentColor" stroke-width="1.2"/></svg>'],
	['grep', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.8" cy="6.8" r="3.8" stroke="currentColor" stroke-width="1.2"/><path d="m9.7 9.7 3.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'],
	['glob', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4a1 1 0 0 1 1-1h3.4L8 4.5h4a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'],
	['ls', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4a1 1 0 0 1 1-1h3.4L8 4.5h4a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'],
	['bash', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="m4.5 6 2 2-2 2M8.5 10h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'],
	['bash_output', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 12.5V8M6.5 12.5V4M10 12.5V6M13 12.5V2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'],
	['todowrite', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="m5 8 2 2 4-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'],
	['todoread', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M5 5.5h6M5 8h6M5 10.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'],
	['websearch', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M2.8 8h10.4M8 2.5c1.5 1.5 2.2 3.3 2.2 5.5S9.5 12 8 13.5C6.5 12 5.8 10.2 5.8 8S6.5 4 8 2.5Z" stroke="currentColor" stroke-width="1.1"/></svg>'],
	['webfetch', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.2 9.8 9.8 6.2M5 11H4a2.5 2.5 0 0 1 0-5h2M11 5h1a2.5 2.5 0 0 1 0 5h-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'],
	['codesearch', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.8" cy="6.8" r="3.8" stroke="currentColor" stroke-width="1.2"/><path d="m9.7 9.7 3.5 3.5M5.2 6.8h3.2M6.8 5.2v3.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'],
	['skill', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m8 2 1.1 2.2 2.4.3-1.7 1.7.4 2.4L8 7.5 5.8 8.6l.4-2.4-1.7-1.7 2.4-.3zM3 10.5h10M4.5 13h7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>'],
	['task', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="5" r="2.5" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 13c.4-2.2 2-3.5 4.5-3.5s4.1 1.3 4.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'],
	['multitask', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.1"/><circle cx="11" cy="5" r="2" stroke="currentColor" stroke-width="1.1"/><path d="M2.5 12c.3-1.6 1.2-2.5 2.5-2.5s2.2.9 2.5 2.5M8.5 12c.3-1.6 1.2-2.5 2.2-2.5 1.3 0 2.2.9 2.8 2.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>'],
	['generate', '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m8 2 .8 4.2L13 7l-4.2.8L8 12l-.8-4.2L3 7l4.2-.8zM12.5 11.5l.3 1.5 1.5.3-1.5.3-.3 1.4-.3-1.4-1.5-.3 1.5-.3z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>']
])
const DEFAULT_TOOL_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m9.2 2.2 4.6 4.6-2.1 2.1-1.1-1.1-4.4 4.4-2.2.2.2-2.2 4.4-4.4-1.1-1.1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'

/* 思考/智能体/错误等非工具行的 PC 同源 SVG（THINKING_SVG / AGENT_SVG） */
export const THINKING_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m8 1.5.9 3.6 3.6.9-3.6.9L8 10.5l-.9-3.6-3.6-.9 3.6-.9zM12.5 10l.5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>'
export const AGENT_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3" y="5" width="10" height="8" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M8 5V2.5M6 2.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="6" cy="8.5" r="1" fill="currentColor"/><circle cx="10" cy="8.5" r="1" fill="currentColor"/><path d="M6 11h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'

/** 裸工具名：去 source/ 前缀（PC bareName 同口径） */
export function bareToolName(toolName: string, toolTitle: string): string {
	const name: string = toolName.trim()
	if (name.length > 0) {
		const slash: number = name.lastIndexOf('/')
		return slash >= 0 ? (name.slice(slash + 1) || 'tool') : name
	}
	const title: string = toolTitle.trim()
	const ts: number = title.lastIndexOf('/')
	return ts >= 0 ? (title.slice(ts + 1) || 'tool') : (title.length > 0 ? title : 'tool')
}

/** 本地化显示名（PC resolveToolPresentation.displayName 同口径，含 source/ 前缀保留）。
 *  过程行短标签：bash/bash_output 显示名词「终端命令」（PC qoderToolLabel）。 */
export function resolveToolLabel(toolName: string, toolTitle: string): string {
	const bare: string = bareToolName(toolName, toolTitle)
	if (bare === 'bash' || bare === 'bash_output') {
		const v: string = i18n.global.t('chat.action_bash_done')
		if (v.length > 0 && v !== 'chat.action_bash_done') return v
	}
	const key: string | undefined = TOOL_I18N_KEY.get(bare)
	let localized: string = bare
	if (key != null) {
		const v: string = i18n.global.t(key)
		if (v.length > 0 && v !== key) localized = v
	}
	/* 非嵌套来源前缀：title 带 source/ 时保留（PC 同口径） */
	const title: string = toolTitle.trim()
	const suffix: string = '/' + bare
	if (title.length > suffix.length && title.slice(title.length - suffix.length) === suffix) {
		return title.slice(0, title.length - suffix.length) + '/' + localized
	}
	return localized
}

/* data-uri 缓存：key = 工具裸名|色值。SVG 编码一次，滚动/流式不重算。 */
const uriCache: Map<string, string> = new Map<string, string>()

function svgToUri(svg: string, color: string): string {
	const ck: string = svg.length.toString() + '|' + color
	const hit: string | undefined = uriCache.get(ck)
	if (hit != null) return hit
	const colored: string = svg.split('currentColor').join(color)
	const bytes = new TextEncoder().encode(colored)
	const uri: string = 'data:image/svg+xml;base64,' + uni.arrayBufferToBase64(bytes.buffer as ArrayBuffer)
	uriCache.set(ck, uri)
	return uri
}

/** 工具行图标 data-uri（PC TOOL_ICON 同源 SVG，按主题/状态着色）。
 *  dark：暗色主题；live：运行中（accent 绿，PC .tool-type-icon streaming 同款）。 */
export function toolIconUri(toolName: string, toolTitle: string, dark: boolean, live: boolean): string {
	const bare: string = bareToolName(toolName, toolTitle)
	const svg: string = TOOL_ICON.get(bare) ?? DEFAULT_TOOL_ICON
	const color: string = live ? '#10b981' : (dark ? '#9ca3af' : '#6b7280')
	return svgToUri(svg, color)
}

/** 思考行图标（星芒，PC THINKING_SVG 语义） */
export function thinkingIconUri(dark: boolean, live: boolean): string {
	return svgToUri(THINKING_ICON_SVG, live ? '#10b981' : (dark ? '#9ca3af' : '#6b7280'))
}

/** 智能体徽章图标（机器人，PC AGENT_SVG 语义） */
export function agentIconUri(dark: boolean, live: boolean): string {
	return svgToUri(AGENT_ICON_SVG, live ? '#10b981' : (dark ? '#9ca3af' : '#6b7280'))
}

/** 过程文本段图标（摘要 chips 专用）：文档线条，与 write 工具图标同族但独立常量，
 *  语义是「过程解释文本段数」（chat.turn.texts），不随工具图标表演进。 */
const PROCESS_TEXT_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 1.8h6l3 3v9.4h-9z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.5 1.8v3h3M5.5 8h5M5.5 10.5h3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
export function processTextIconUri(dark: boolean): string {
	return svgToUri(PROCESS_TEXT_ICON_SVG, dark ? '#9ca3af' : '#6b7280')
}

/** 该块是否有 PC 同源 SVG 图标（工具/思考/智能体）；其余仍走 rice-icon */
export function hasSvgIcon(kind: string): boolean {
	return kind === 'tool' || kind === 'thinking' || kind === 'agent'
}