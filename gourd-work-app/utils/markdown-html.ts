/**
 * AI 正文 markdown → rich-text HTML 的展示层样式管道（对齐 PC .md-content 的字号阶梯）。
 *
 * 为什么需要它：markdown 解析器（utils/markdown-parse.uts，自研纯 UTS 全平台实现）
 * 产出的是**无样式语义 HTML**（h2/strong/code/ul…），rich-text 不认识工程里的
 * CSS class，必须把样式以内联 style 注入标签。本模块只做「标签 → 内联样式」的
 * 纯文本变换，不解析 markdown 语法（语法解析在 markdown-parse.uts 里）。
 *
 * 设计口径（与桌面 md-content 一致）：
 * - 正文 14px/22px；标题 h1 20 → h6 14 加粗；代码块深底等宽、行内 code 浅底；
 * - 引用块左侧竖线；表格边框中性半透明色（深浅主题都可读）；
 * - 链接品牌蓝；图片 max-width 防溢出。
 *
 * 纯函数、零依赖（uni/vue 都不碰）：verify-mobile-fixes.cjs 直接抽出来在 node 里跑断言。
 * 全平台（Android/iOS/鸿蒙/Web）由 app-md-text 组件调用，无原生依赖。
 */

/** 找到 tag 的下一个开标签起点（跳过 </tag 与 <tagxxx 这类前缀撞名） */
export function findMdOpenTag(source: string, tag: string, fromIndex: number): number {
	const needle = '<' + tag
	let cursor = fromIndex
	while (cursor < source.length) {
		const index = source.indexOf(needle, cursor)
		if (index < 0) return -1
		const nextIndex = index + needle.length
		const next = nextIndex < source.length ? source.charAt(nextIndex) : ''
		if (next === '>' || next === ' ' || next === '\t' || next === '\r' || next === '\n' || next === '/') return index
		cursor = nextIndex
	}
	return -1
}

/** 给开标签追加内联样式；已有 style 属性则接在其值尾部 */
function appendMdTagStyle(openTag: string, style: string): string {
	const marker = 'style="'
	const styleIndex = openTag.indexOf(marker)
	if (styleIndex >= 0) {
		const valueStart = styleIndex + marker.length
		const valueEnd = openTag.indexOf('"', valueStart)
		if (valueEnd >= valueStart) {
			const separator = valueEnd > valueStart && openTag.charAt(valueEnd - 1) !== ';' ? ';' : ''
			return openTag.slice(0, valueEnd) + separator + style + openTag.slice(valueEnd)
		}
	}
	const closeIndex = openTag.lastIndexOf('>')
	if (closeIndex < 0) return openTag
	return openTag.slice(0, closeIndex) + ' style="' + style + '"' + openTag.slice(closeIndex)
}

/** 把 source 里所有 <tag …> 开标签注入 style（闭合标签与文本原样保留） */
function styleMdOpenTags(source: string, tag: string, style: string): string {
	let result = ''
	let cursor = 0
	while (cursor < source.length) {
		const start = findMdOpenTag(source, tag, cursor)
		if (start < 0) {
			result += source.slice(cursor)
			break
		}
		const end = source.indexOf('>', start)
		if (end < 0) {
			result += source.slice(cursor)
			break
		}
		result += source.slice(cursor, start)
		result += appendMdTagStyle(source.slice(start, end + 1), style)
		cursor = end + 1
	}
	return result
}

/** 行内 code 专用：跳过处于未闭合 <pre> 内部的 code（块内 code 已单独配色）。
 *  用「扫描到当前位置时的 pre 深度」判断而不是预计算偏移——字符串在注入过程中
 *  不断变长，任何预计算区间都会错位。 */
function styleInlineCode(source: string, style: string): string {
	let result = ''
	let cursor = 0
	let preDepth = 0
	while (cursor < source.length) {
		const codeStart = findMdOpenTag(source, 'code', cursor)
		const preOpen = findMdOpenTag(source, 'pre', cursor)
		const preClose = source.indexOf('</pre>', cursor)
		// 先处理最靠前的事件（code 注入 / pre 开 / pre 闭），维护深度
		const next = Math.min(
			codeStart < 0 ? Infinity : codeStart,
			preOpen < 0 ? Infinity : preOpen,
			preClose < 0 ? Infinity : preClose)
		if (!isFinite(next)) {
			result += source.slice(cursor)
			break
		}
		if (next === preClose) {
			result += source.slice(cursor, preClose + '</pre>'.length)
			preDepth = Math.max(0, preDepth - 1)
			cursor = preClose + '</pre>'.length
			continue
		}
		if (next === preOpen) {
			const end = source.indexOf('>', preOpen)
			if (end < 0) { result += source.slice(cursor); break }
			result += source.slice(cursor, end + 1)
			preDepth += 1
			cursor = end + 1
			continue
		}
		const end = source.indexOf('>', codeStart)
		if (end < 0) { result += source.slice(cursor); break }
		result += source.slice(cursor, codeStart)
		const openTag = source.slice(codeStart, end + 1)
		result += preDepth > 0 ? openTag : appendMdTagStyle(openTag, style)
		cursor = end + 1
	}
	return result
}

/** 只对落在 ranges 内的 <tag …> 开标签注入 style（与 styleMdOpenTags 的 skip 语义互补） */
function styleMdOpenTagsInRanges(source: string, tag: string, style: string, ranges: Array<[number, number]>): string {
	let result = ''
	let cursor = 0
	while (cursor < source.length) {
		const start = findMdOpenTag(source, tag, cursor)
		if (start < 0) {
			result += source.slice(cursor)
			break
		}
		const end = source.indexOf('>', start)
		if (end < 0) {
			result += source.slice(cursor)
			break
		}
		result += source.slice(cursor, start)
		const openTag = source.slice(start, end + 1)
		let inside = false
		for (const range of ranges) {
			if (start >= range[0] && start < range[1]) { inside = true; break }
		}
		result += inside ? appendMdTagStyle(openTag, style) : openTag
		cursor = end + 1
	}
	return result
}

/** 找出所有 <pre …>…</pre> 的区间（未闭合的 pre 延伸到文末——流式尾块） */
function preRanges(source: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = []
	let cursor = 0
	while (cursor < source.length) {
		const start = findMdOpenTag(source, 'pre', cursor)
		if (start < 0) break
		const close = source.indexOf('</pre>', start)
		const end = close < 0 ? source.length : close + '</pre>'.length
		ranges.push([start, end])
		cursor = end
	}
	return ranges
}

/**
 * 无样式语义 HTML → 可交给 rich-text 的带样式 HTML。
 * dark=true 时正文用浅色（rich-text 不继承外层 color，必须显式给）。
 */
export function prepareMdHtml(html: string, dark: boolean): string {
	const text = dark ? '#e8eaed' : '#1f2328'
	const dim = dark ? '#9aa0a6' : '#6b7280'
	let result = html
	result = styleMdOpenTags(result, 'h1', 'font-size:20px;line-height:28px;font-weight:700;margin:10px 0 6px;color:' + text + ';')
	result = styleMdOpenTags(result, 'h2', 'font-size:18px;line-height:26px;font-weight:700;margin:10px 0 6px;color:' + text + ';')
	result = styleMdOpenTags(result, 'h3', 'font-size:16px;line-height:24px;font-weight:700;margin:8px 0 4px;color:' + text + ';')
	result = styleMdOpenTags(result, 'h4', 'font-size:15px;line-height:23px;font-weight:600;margin:8px 0 4px;color:' + text + ';')
	result = styleMdOpenTags(result, 'h5', 'font-size:14px;line-height:22px;font-weight:600;margin:6px 0 4px;color:' + text + ';')
	result = styleMdOpenTags(result, 'h6', 'font-size:14px;line-height:22px;font-weight:600;margin:6px 0 4px;color:' + dim + ';')
	result = styleMdOpenTags(result, 'p', 'margin:4px 0;')
	result = styleMdOpenTags(result, 'ul', 'margin:4px 0;padding-left:22px;')
	result = styleMdOpenTags(result, 'ol', 'margin:4px 0;padding-left:22px;')
	result = styleMdOpenTags(result, 'li', 'margin:2px 0;line-height:22px;')
	result = styleMdOpenTags(result, 'blockquote', 'margin:6px 0;padding-left:10px;border-left:3px solid rgba(127,127,127,0.38);color:' + dim + ';')
	result = styleMdOpenTags(result, 'a', 'color:#2979ff;')
	// 代码块：深底 + 显式浅色文字。rich-text 不继承 color，块内文字必须钉死浅色，
	// 否则亮色主题下深底黑字不可读。区间必须按「原始 html」计算并最先处理：
	// 后续每次注入都会改变字符串长度，先算后注的偏移全部作废（skipRanges 会错位）。
	const blocks = preRanges(result)
	result = styleMdOpenTagsInRanges(result, 'code', 'font-family:monospace;font-size:13px;line-height:20px;color:#e5e7eb;', blocks)
	result = styleMdOpenTags(result, 'pre', 'margin:6px 0;padding:10px;border-radius:8px;background-color:#111827;color:#e5e7eb;')
	// 行内 code（pre 之外）：浅灰底等宽，跟随正文色。区间随上面两次注入平移，
	// 这里不再按偏移跳过，改为逐个检查该 code 前面最近的未闭合 pre（见 styleInlineCode）
	result = styleInlineCode(result, 'font-family:monospace;font-size:13px;line-height:20px;background-color:rgba(127,127,127,0.16);')
	result = styleMdOpenTags(result, 'table', 'border-collapse:collapse;margin:6px 0;')
	result = styleMdOpenTags(result, 'th', 'border:1px solid rgba(127,127,127,0.38);padding:6px 8px;font-weight:700;background-color:rgba(127,127,127,0.12);')
	result = styleMdOpenTags(result, 'td', 'border:1px solid rgba(127,127,127,0.38);padding:6px 8px;')
	result = styleMdOpenTags(result, 'img', 'max-width:100%;')
	result = styleMdOpenTags(result, 'hr', 'margin:10px 0;border:none;border-top:1px solid rgba(127,127,127,0.3);')
	return result
}