/**
 * AI 正文 markdown → rich-text HTML 的展示层样式管道（对齐 PC .md-content 的字号阶梯）。
 *
 * 为什么需要它：markdown 解析器（utils/markdown-parse.uts，自研纯 UTS 全平台实现）
 * 产出的是**无样式语义 HTML**（h2/strong/code/ul…），rich-text 不认识工程里的
 * CSS class，必须把样式以内联 style 注入标签。本模块只做「标签 → 内联样式」的
 * 纯文本变换，不解析 markdown 语法（语法解析在 markdown-parse.uts 里）。
 *
 * 设计口径（与桌面 md-content 一致）：
 * - 正文 14px/24px；标题 h1 20 → h6 14 加粗；围栏代码块主题底色等宽（几何在
 *   app-md-text 原生容器）、行内 code 零底色只留等宽字色（native inline span
 *   渲染不出圆角/内距，自造底色块曾是用户三轮报障来源，2026-11-27 拍板去掉）；
 * - UCSS 安全：不用 margin/padding/border 简写（原生端静默失效），块间距由
 *   app-md-text 的分段容器单边 margin-bottom 承担。
 * - 引用块左侧竖线；表格边框中性半透明色（深浅主题都可读）；
 * - 链接品牌蓝；图片 max-width 防溢出。
 *
 * 纯函数、零依赖（uni/vue 都不碰）：verify-mobile-fixes.cjs 直接抽出来在 node 里跑断言。
 * 全平台（Android/iOS/鸿蒙/Web）由 app-md-text 组件调用，无原生依赖。
 */

/* ---------------- 块级载体分类（2026-11-27 用户报障「代码块无圆角、行距连在一起」） ----------------
 * native rich-text（vapor C 实现）对 pre/blockquote 只认 color/background-color 等少数属性，
 * border-radius / padding / border-left 一律静默丢弃 → 直角贴字、引用无竖线。
 * 圆角/内边距/竖线必须落在原生 view 容器上（app-md-text 按 kind 分派），
 * rich-text 只负责容器内部的文字排版。以下三个纯函数供组件与 verify 脚本共用。 */

/** 块级载体分类：'code' = 围栏代码块；'quote' = 引用块；'rich' = 其余走 rich-text */
export function mdBlockKind(html: string): string {
	if (html.indexOf('<pre>') === 0) return 'code'
	if (html.indexOf('<blockquote>') === 0) return 'quote'
	return 'rich'
}

/** HTML 实体还原（markdown-parse mdEscape 的逆变换；&amp; 必须最后还原，
 *  否则 &amp;lt; 会被二次解码成 < ——代码字面量保真） */
function mdUnescape(text: string): string {
	return text.split('&lt;').join('<').split('&gt;').join('>')
		.split('&quot;').join('"').split('&amp;').join('&')
}

/** 围栏块 → 纯代码文本（剥 pre/code 壳 + 实体还原）。
 *  解析器 mdCodeBlockHtml 恒产出闭合壳（流式未闭栏也闭合），indexOf 足够，无需正则。 */
export function mdCodeInner(html: string): string {
	const open = html.indexOf('<code')
	if (open < 0) return ''
	const gt = html.indexOf('>', open)
	if (gt < 0) return ''
	const close = html.indexOf('</code>', gt + 1)
	const body = close < 0 ? html.substring(gt + 1) : html.substring(gt + 1, close)
	return mdUnescape(body)
}

/** 引用块 → 内部语义 HTML（剥最外层 blockquote 壳；嵌套引用保留，
 *  内部仍走 prepareMdHtml 管道，竖线由外层原生容器承担） */
export function mdQuoteInner(html: string): string {
	const open = '<blockquote>'
	const close = '</blockquote>'
	if (html.indexOf(open) !== 0) return html
	let inner = html.substring(open.length)
	if (inner.length >= close.length && inner.lastIndexOf(close) === inner.length - close.length) {
		inner = inner.substring(0, inner.length - close.length)
	}
	return inner
}

/** 混合块拆分：把「列表项内围栏」等 rich+code 混排 HTML 按 <pre> 边界拆成子段。
 *  code 子段 = 剥壳后的纯代码文本（进原生容器，圆角/底色/内边距由容器承担）；
 *  rich 子段 = 其余语义 HTML（渲染时再过 prepareMdHtml）。
 *  纯函数、与组件/verify 共用；未闭合 pre（流式尾块）延伸到串尾。
 *
 *  【codereview 修复 · 2026-11-27 嵌套围栏丢项】旧实现从 pre 起点线性切分，
 *  rich 子段里悬着未闭合的 <ul><li>（嵌套列表项内围栏）→ rich-text 遇不成对
 *  标签渲染异常/丢内容。现在扫描维护容器栈（ul/ol/li/blockquote）：切出 code
 *  子段前先把悬空容器闭合补进前一个 rich 子段，code 之后按同一缩进重开容器
 *  补进后一个 rich 子段——每个 rich 子段都是自平衡 HTML，code 子段在视觉上
 *  保持原列表缩进（ul/ol/li 的 padding 由 prepareMdHtml 注入）。
 *  解析器只产出无属性容器开标签（<ul>/<ol start="N">/<li>/<blockquote>），
 *  自闭合标签（<br/>、<img …/>）不入栈。 */
export type MdPart = { kind: string; html: string; inner: string }

/** 混合块容器栈的入栈判定：仅列表/引用容器（pre 由拆分主循环处理） */
function isMdContainerTag(tag: string): boolean {
	return tag === 'ul' || tag === 'ol' || tag === 'li' || tag === 'blockquote'
}

/** 容器开/闭事件（位置 + 标签整串；pos<0 = 无事件）。命名类型保证 UTS 模板推导
 *  与 verify 脚本 strip TS 的可剥性（混合元组在两端都难处理）。 */
export type MdContainerEvent = { pos: number; closed: boolean; tag: string }

/** 从 from 起找下一个容器开/闭事件；无事件 pos=-1。开标签须完整（含 '>'）。 */
function nextMdContainerEvent(source: string, from: number): MdContainerEvent {
	let best = -1
	let bestTag = ''
	let bestClose = false
	const tags: string[] = ['ul', 'ol', 'li', 'blockquote']
	for (let ti = 0; ti < tags.length; ti++) {
		const tag = tags[ti]
		const open = findMdOpenTag(source, tag, from)
		if (open >= 0 && (best < 0 || open < best)) {
			const gt = source.indexOf('>', open)
			if (gt >= 0) { best = open; bestTag = source.slice(open, gt + 1); bestClose = false }
		}
		const closeIdx = source.indexOf('</' + tag + '>', from)
		if (closeIdx >= 0 && (best < 0 || closeIdx < best)) {
			best = closeIdx; bestTag = '</' + tag + '>'; bestClose = true
		}
	}
	return { pos: best, closed: bestClose, tag: bestTag } as MdContainerEvent
}

export function splitRichCode(source: string): MdPart[] {
	const out: MdPart[] = []
	let cursor = 0
	let richStart = 0
	// 容器栈：悬空开标签整串（重开时原样保留 <ol start="N"> 等属性）
	const stack: string[] = []
	// 上一个 code 之后待重开的容器前缀（并入下一个 rich 子段头部）
	let pendingReopen = ''
	while (cursor < source.length) {
		const start = findMdOpenTag(source, 'pre', cursor)
		if (start < 0) break
		// 先把 [cursor, start) 之间的容器开/闭事件过一遍栈（cursor 单调推进，
		// 每个区间只扫一次；richStart 可能早于 cursor——重开前缀已单独记账）
		let scan = cursor
		while (scan < start) {
			const ev: MdContainerEvent = nextMdContainerEvent(source, scan)
			if (ev.pos < 0 || ev.pos >= start) break
			if (ev.closed) {
				if (stack.length > 0) stack.pop()
			} else if (ev.tag.indexOf('/>') < 0) {
				stack.push(ev.tag)
			}
			scan = ev.pos + ev.tag.length
		}
		// rich 子段：重开前缀 + 本体 + 悬空容器的补闭合（自平衡）
		let richHtml = pendingReopen + source.slice(richStart, start)
		pendingReopen = ''
		for (let i = stack.length - 1; i >= 0; i--) {
			richHtml += '</' + mdTagNameOf(stack[i]) + '>'
		}
		if (richHtml.length > 0) out.push({ kind: 'rich', html: richHtml, inner: '' })
		// code 子段
		const close = source.indexOf('</pre>', start)
		const end = close < 0 ? source.length : close + '</pre>'.length
		const shell = source.slice(start, end)
		out.push({ kind: 'code', html: shell, inner: mdCodeInner(shell) })
		// code 之后按原栈重开容器（保持列表缩进），前缀并入下一个 rich 子段
		for (let i = 0; i < stack.length; i++) pendingReopen += stack[i]
		richStart = end
		cursor = end
	}
	// 尾段 rich（重开前缀 + 剩余本体；源里自带的闭合原样保留）。
	// 流式未闭栏延伸到串尾时，重开前缀是「只有开标签没有内容」的空壳——
	// 渲染成空列表项（幽灵 bullet），必须丢弃（尾段本体为空即整段不出）。
	const tailBody = source.slice(richStart)
	const tail = tailBody.length > 0 ? pendingReopen + tailBody : ''
	if (tail.length > 0) out.push({ kind: 'rich', html: tail, inner: '' })
	if (out.length === 0) out.push({ kind: 'rich', html: source, inner: '' })
	return out
}

/** 开标签整串 → 标签名（'<ol start="3">' → 'ol'） */
function mdTagNameOf(openTag: string): string {
	let i = 1
	let name = ''
	while (i < openTag.length) {
		const c = openTag.charAt(i)
		if (c === ' ' || c === '>' || c === '\t' || c === '/') break
		name += c
		i++
	}
	return name
}

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
	// 【UCSS 纪律】rich-text HTML 内联样式里的 margin/padding/border 简写解析不可靠，
	// 会静默失效：桌面 .md-content 的段落间距在手机上表现为「换行连在一起」。
	// 块间呼吸感一律由 app-md-text 的分段容器单边 margin-bottom 承担；这里只保留
	// 长属性展开的 padding，不用 margin/padding/border 简写。
	const pad = (top: number, right: number, bottom: number, left: number): string =>
		'padding-top:' + top.toString() + 'px;padding-right:' + right.toString() + 'px;'
		+ 'padding-bottom:' + bottom.toString() + 'px;padding-left:' + left.toString() + 'px;'
	let result = html
	result = styleMdOpenTags(result, 'h1', 'font-size:20px;line-height:28px;font-weight:700;color:' + text + ';')
	result = styleMdOpenTags(result, 'h2', 'font-size:18px;line-height:26px;font-weight:700;color:' + text + ';')
	result = styleMdOpenTags(result, 'h3', 'font-size:16px;line-height:24px;font-weight:700;color:' + text + ';')
	result = styleMdOpenTags(result, 'h4', 'font-size:15px;line-height:23px;font-weight:600;color:' + text + ';')
	result = styleMdOpenTags(result, 'h5', 'font-size:14px;line-height:22px;font-weight:600;color:' + text + ';')
	result = styleMdOpenTags(result, 'h6', 'font-size:14px;line-height:22px;font-weight:600;color:' + dim + ';')
	result = styleMdOpenTags(result, 'p', 'line-height:24px;')
	result = styleMdOpenTags(result, 'ul', 'padding-left:22px;line-height:24px;')
	result = styleMdOpenTags(result, 'ol', 'padding-left:22px;line-height:24px;')
	// 列表行间距（PC .md-content li { margin:4px 0 }）：margin 简写在 native 下静默失效，
	// 用单边 margin-bottom 展开（末项多出的 4px 由块间距吸收，视觉与 PC 一致）
	result = styleMdOpenTags(result, 'li', 'line-height:24px;margin-bottom:4px;')
	// 引用竖线/内边距由 app-md-text 的原生 view 承担（rich-text 的 border-left 不渲染），
	// 这里只保留次级字色
	result = styleMdOpenTags(result, 'blockquote', 'color:' + dim + ';')
	result = styleMdOpenTags(result, 'a', 'color:#2979ff;')
	// 代码块（pre）：正常路径由 app-md-text 用原生 view 容器承载（圆角/内边距在
	// native rich-text 上不渲染）。这里保留 pre 的底色/字色注入作为兜底路径
	// （Web/降级形态下 prepareMdHtml 单独使用仍可读）。
	// 【主题化 · 2026-11-27 用户报障「代码块和 PC 不一致」】PC --bg-code-block
	// 亮色 #f6f6f7 浅底 / 暗色 #0f0f11 深底，此前两端都钉死深底 #111827——
	// 亮色主题下移动端一块突兀黑块。兜底路径与原生容器同色板（theme.scss code-block-*）。
	const codeBg: string = dark ? '#0f0f11' : '#f6f6f7'
	const codeText: string = dark ? '#d4d4d4' : '#24292e'
	const blocks = preRanges(result)
	result = styleMdOpenTagsInRanges(result, 'code', 'font-family:monospace;font-size:13px;line-height:20px;color:' + codeText + ';', blocks)
	result = styleMdOpenTags(result, 'pre', pad(16, 18, 16, 18) + 'border-radius:10px;background-color:' + codeBg + ';color:' + codeText + ';')
	// 行内 code（pre 之外）：PC .md-content code = --bg-code 底 + 5px 圆角 + 2/7 内距。
	// 【native 实测】inline span 上的 border-radius/padding 渲染不出：padding 还会把
	// 底色向上下撑出 4px 跨行连成一片（用户报障「换行上下连接在一起」）——自研样式
	// 管道此前在 inline span 上自造 rgba(127,127,127,.16) 灰胶囊，正是用户三轮报障
	// 「暗色正文后全是黑色阴影块 / 亮色阴影块圆角不对齐 PC」的真因。
	// 【2026-11-27 用户拍板「修改不好就去掉」】inline span 几何 native 无解，
	// 亮暗两端一律【零底色】：只留等宽字体+字号+字色区分行内代码（围栏代码块的
	// PC 底色/圆角/内距由 app-md-text 原生 view 容器承担，不受影响）。
	// 禁止再给 inline code 注入 background-color/border-radius/padding（verify 回归锁）。
	const inlineCode: string = 'font-family:monospace;font-size:13px;line-height:20px;color:' + text + ';'
	result = styleInlineCode(result, inlineCode)
	result = styleMdOpenTags(result, 'table', 'border-collapse:collapse;')
	result = styleMdOpenTags(result, 'th', 'border-top-width:1px;border-right-width:1px;border-bottom-width:1px;border-left-width:1px;border-top-style:solid;border-right-style:solid;border-bottom-style:solid;border-left-style:solid;border-top-color:rgba(127,127,127,0.38);border-right-color:rgba(127,127,127,0.38);border-bottom-color:rgba(127,127,127,0.38);border-left-color:rgba(127,127,127,0.38);' + pad(6, 8, 6, 8) + 'font-weight:700;background-color:rgba(127,127,127,0.12);')
	result = styleMdOpenTags(result, 'td', 'border-top-width:1px;border-right-width:1px;border-bottom-width:1px;border-left-width:1px;border-top-style:solid;border-right-style:solid;border-bottom-style:solid;border-left-style:solid;border-top-color:rgba(127,127,127,0.38);border-right-color:rgba(127,127,127,0.38);border-bottom-color:rgba(127,127,127,0.38);border-left-color:rgba(127,127,127,0.38);' + pad(6, 8, 6, 8))
	result = styleMdOpenTags(result, 'img', 'max-width:100%;')
	result = styleMdOpenTags(result, 'hr', 'border-top-width:1px;border-top-style:solid;border-top-color:rgba(127,127,127,0.3);')
	return result
}