/**
 * 工具展开明细的结构化投影（PC app-message.js window._toolRenderers 的移动端等价物）。
 *
 * 【2026-11-27 用户报障「编辑等展开展示的内容和 PC 全都不一样」真因】
 * 移动端此前把工具结果 body 整段 dump 成一个纯文本 text 节点（displayText 截断 2400），
 * 而 PC（唯一源 gourd-work/desktop/ui）对每类工具有专用渲染器：
 *  - edit：git-diff 逐行着色 + 双列行号（args.diff / old_str+new_str 合成）+ 结果段；
 *  - read/write/todowrite/todoread：浅底等宽文件体（.tool-file-pre）；
 *  - bash/bash_output：$ 命令行 + stdout 浅底块（.bash-cmd/.bash-stdout）；
 *  - grep：按「路径:行号: 内容」归组（.grep-file/.grep-hit + 汇总行）；
 *  - glob/ls：[FILE]/[DIR] 文件列表（.file-entry + 汇总行）；
 *  - 其余：浅底纯文本兜底（.tool-plain-out）。
 * 本模块把 body+args 投影成「结构化行数组」，气泡层按 kind 渲染原生 view/text
 * （rich-text 不渲染底色几何；逐行原生节点是唯一可靠路径）。
 *
 * 设计约束：
 * - 纯函数、零依赖（不 import uni/vue/i18n）：文案经参数传入（调用方给词条值），
 *   verify-mobile-fixes.cjs 直接抽出来在 node 里跑行为断言。
 * - 只用 TS/UTS 双兼容子集：显式类型、无正则、无解构（与 markdown-html.ts 同口径）。
 * - 行数封顶 MAX_ROWS：原生逐行节点成本高于 rich-text，超长输出截断加省略行
 *   （PC 卡体 320px 内滚等价：移动端在批次限高窗内滚，行数封顶防节点爆炸）。
 */

export type ToolDetailRow = {
	/** diff-add/diff-del/diff-ctx/diff-hunk/diff-head | bash-cmd/bash-out |
	 *  grep-file/grep-hit/grep-note | file/file-dir | summary | result/result-error | plain */
	kind: string
	/** 左列（diff 旧行号 / grep 行号）；无则空串 */
	num: string
	/** 右列（diff 新行号）；无则空串 */
	num2: string
	/** 主文本 */
	text: string
}

export type ToolDetail = {
	/** edit / bash / grep / files / file / plain */
	view: string
	rows: ToolDetailRow[]
	/** 截断标记：输出行数超封顶（尾部加省略提示行） */
	truncated: boolean
}

/** 行节点封顶：批次限高窗内滚，1000 行原生节点已是移动端上限（PC 是全量 DOM+内滚） */
const MAX_ROWS = 1000

function row(kind: string, num: string, num2: string, text: string): ToolDetailRow {
	return { kind: kind, num: num, num2: num2, text: text } as ToolDetailRow
}

/** ANSI 削离（PC stripAnsiForDisplay 同口径）：CSI/OSC/裸 ESC 序列。
 *  历史落盘脏数据与 Java 内核直出都可能带码；只处理带 ESC 的序列，
 *  不碰方括号文本（正则/栈帧里的 [31] 原样保留）。无正则：按码元扫描。 */
export function stripAnsi(s: string): string {
	if (s.indexOf('\u001b') < 0) return s
	let out = ''
	let i = 0
	while (i < s.length) {
		const ch = s.charAt(i)
		if (ch !== '\u001b') { out += ch; i++; continue }
		const next = i + 1 < s.length ? s.charAt(i + 1) : ''
		if (next === '[') {
			// CSI：ESC [ 参数/中间字节 直到终结字节 @-~
			let j = i + 2
			while (j < s.length) {
				const c = s.charCodeAt(j)
				if (c >= 0x40 && c <= 0x7e) { j++; break }
				j++
			}
			i = j
			continue
		}
		if (next === ']') {
			// OSC：ESC ] … BEL 或 ST(ESC \)
			let j = i + 2
			while (j < s.length) {
				const c = s.charAt(j)
				if (c === '\u0007') { j++; break }
				if (c === '\u001b' && j + 1 < s.length && s.charAt(j + 1) === '\\') { j += 2; break }
				j++
			}
			i = j
			continue
		}
		// 裸 ESC 序列：ESC + 单终结字符
		i = next.length > 0 ? i + 2 : i + 1
	}
	return out
}

/** edit diff 合成（PC synthesizeEditDiff 逐字同口径）：Rust 内核无 args.diff 时
 *  由 old_str/new_str 合成带 @@ 行号的 diff；首行号从结果文案 "at line L" 解析。
 *  CRLF 归一 + 尾部换行 split 出的空串行剔除（避免多画一行空删除/新增）。 */
export function synthesizeEditDiff(oldStr: string, newStr: string, resultText: string): string {
	if (oldStr.length === 0 && newStr.length === 0) return ''
	let startLine = 1
	const at = resultText.indexOf('at line ')
	if (at >= 0) {
		let j = at + 8
		let digits = ''
		while (j < resultText.length) {
			const c = resultText.charAt(j)
			if (c < '0' || c > '9') break
			digits += c
			j++
		}
		if (digits.length > 0) {
			const n = parseInt(digits)
			if (n > 0) startLine = n
		}
	}
	const oldNorm = oldStr.split('\r\n').join('\n')
	const newNorm = newStr.split('\r\n').join('\n')
	const oldLines = oldNorm.split('\n')
	const newLines = newNorm.split('\n')
	if (oldLines.length > 1 && oldLines[oldLines.length - 1] === '' && oldNorm.endsWith('\n')) oldLines.pop()
	if (newLines.length > 1 && newLines[newLines.length - 1] === '' && newNorm.endsWith('\n')) newLines.pop()
	const out: string[] = ['@@ -' + startLine.toString() + ',' + oldLines.length.toString() + ' +' + startLine.toString() + ',' + newLines.length.toString() + ' @@']
	for (let i = 0; i < oldLines.length; i++) out.push('-' + oldLines[i])
	for (let i = 0; i < newLines.length; i++) out.push('+' + newLines[i])
	return out.join('\n')
}

/** @@ -a,b +c,d @@ 解析：返回 [旧起, 新起]；不是 hunk 行返回空数组。无正则扫描。 */
function parseHunk(line: string): number[] {
	if (!line.startsWith('@@')) return []
	// 形如 @@ -12,7 +12,9 @@（,n 可省略）
	const minus = line.indexOf('-')
	const plus = line.indexOf('+')
	if (minus < 0 || plus < 0 || plus < minus) return []
	const readNum = (from: number): number => {
		let j = from
		let digits = ''
		while (j < line.length) {
			const c = line.charAt(j)
			if (c < '0' || c > '9') break
			digits += c
			j++
		}
		return digits.length > 0 ? parseInt(digits) : 0
	}
	const a = readNum(minus + 1)
	const b = readNum(plus + 1)
	if (a === 0 && b === 0) return []
	return [a, b]
}

/** edit：diff 逐行着色 + 双列行号（PC _toolRenderers.edit 同口径）。
 *  结果段（Edited …）成功一行常显；失败带警示标签（文案由调用方传入）。 */
function editDetail(diff: string, result: string, failed: boolean, failLabel: string): ToolDetail {
	const rows: ToolDetailRow[] = []
	let oldNo = 0
	let newNo = 0
	if (diff.length > 0) {
		const lines = diff.split('\n')
		for (let i = 0; i < lines.length && rows.length < MAX_ROWS; i++) {
			const raw = lines[i]
			if (raw.startsWith('+++') || raw.startsWith('---')) {
				rows.push(row('diff-head', '', '', raw))
			} else if (raw.startsWith('@@')) {
				const h = parseHunk(raw)
				if (h.length === 2) { oldNo = h[0]; newNo = h[1] }
				rows.push(row('diff-hunk', '', '', raw))
			} else if (raw.startsWith('+')) {
				rows.push(row('diff-add', '', newNo.toString(), raw))
				newNo++
			} else if (raw.startsWith('-')) {
				rows.push(row('diff-del', oldNo.toString(), '', raw))
				oldNo++
			} else {
				rows.push(row('diff-ctx', oldNo.toString(), newNo.toString(), raw))
				oldNo++
				newNo++
			}
		}
	}
	if (result.length > 0 && result !== diff) {
		if (failed) rows.push(row('result-error', '', '', failLabel + ' ' + result))
		else rows.push(row('result', '', '', result))
	}
	if (rows.length === 0 && failed) rows.push(row('result-error', '', '', failLabel))
	return { view: 'edit', rows: rows, truncated: diff.split('\n').length > MAX_ROWS } as ToolDetail
}

/** bash：$ 命令行 + stdout（PC _toolRenderers.bash：空输出显示 no_output 词条）。
 *  输出逐行 plain 行（bash-out 底色由容器承担），保留空行（终端输出语义）。 */
function bashDetail(command: string, text: string, noOutput: string): ToolDetail {
	const rows: ToolDetailRow[] = []
	if (command.length > 0) rows.push(row('bash-cmd', '', '', command))
	const body = text.length > 0 ? text : noOutput
	const lines = body.split('\n')
	let truncated = false
	for (let i = 0; i < lines.length; i++) {
		if (rows.length >= MAX_ROWS) { truncated = true; break }
		rows.push(row('bash-out', '', '', lines[i]))
	}
	return { view: 'bash', rows: rows, truncated: truncated } as ToolDetail
}

/** grep：「路径:行号: 内容」归组（PC _toolRenderers.grep）。
 *  盘符冒号（C:\…）不误判：行号段必须全数字。Windows 路径取「最后一个 :数字: 边界」。
 *  汇总行文案由调用方拼好传入（「N 个文件 / M 处匹配」）。 */
function grepDetail(text: string, summary: (files: number, hits: number) => string): ToolDetail {
	const rows: ToolDetailRow[] = []
	const paths: string[] = []
	const hitsPerPath: number[] = []
	let totalHits = 0
	let truncated = false
	const lines = text.split('\n')
	// 先收集分组（路径 → 命中行），保持首见顺序
	const groupLines: ToolDetailRow[][] = []
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]
		if (raw.length === 0) continue
		// 从右往左找 ":数字:"：行号段右侧是内容，左侧整体是路径（含盘符冒号）
		let lnStart = -1
		let lnEnd = -1
		for (let j = raw.length - 1; j >= 1; j--) {
			if (raw.charAt(j) !== ':') continue
			// j 是候选右冒号；向左找数字段与左冒号
			let k = j - 1
			let digits = 0
			while (k >= 1 && raw.charAt(k) >= '0' && raw.charAt(k) <= '9') { k--; digits++ }
			if (digits > 0 && raw.charAt(k) === ':') { lnStart = k; lnEnd = j; break }
		}
		if (lnStart < 0) {
			// 非命中行：未完/警告/截断提示挂在上一组（PC grep-note 同口径）
			if (groupLines.length > 0 && (raw.indexOf('未完') >= 0 || raw.indexOf('警告') >= 0 || raw.indexOf('截断') >= 0)) {
				groupLines[groupLines.length - 1].push(row('grep-note', '', '', raw))
			}
			continue
		}
		const p = raw.substring(0, lnStart)
		const ln = raw.substring(lnStart + 1, lnEnd)
		let content = raw.substring(lnEnd + 1)
		if (content.startsWith(' ')) content = content.substring(1)
		let gi = paths.indexOf(p)
		if (gi < 0) { gi = paths.length; paths.push(p); hitsPerPath.push(0); groupLines.push([]) }
		hitsPerPath[gi] += 1
		totalHits++
		groupLines[gi].push(row('grep-hit', ln, '', content))
	}
	if (totalHits === 0) return { view: '', rows: [], truncated: false } as ToolDetail
	rows.push(row('summary', '', '', summary(paths.length, totalHits)))
	for (let g = 0; g < paths.length; g++) {
		if (rows.length >= MAX_ROWS) { truncated = true; break }
		rows.push(row('grep-file', '', '', paths[g]))
		const gl = groupLines[g]
		for (let k = 0; k < gl.length; k++) {
			if (rows.length >= MAX_ROWS) { truncated = true; break }
			rows.push(gl[k])
		}
	}
	return { view: 'grep', rows: rows, truncated: truncated } as ToolDetail
}

/** glob/ls：[FILE]/[DIR] 列表（PC renderFileListing）。树形字符（│├└）走兜底。 */
function fileListing(text: string, summary: (n: number) => string): ToolDetail {
	const rows: ToolDetailRow[] = []
	const lines = text.split('\n')
	let count = 0
	let truncated = false
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]
		if (raw.length === 0) continue
		if (raw.indexOf('│') >= 0 || raw.indexOf('├') >= 0 || raw.indexOf('└') >= 0) {
			return { view: '', rows: [], truncated: false } as ToolDetail
		}
		let kind = ''
		let rest = ''
		if (raw.startsWith('[FILE]')) { kind = 'file'; rest = raw.substring(6) }
		else if (raw.startsWith('[DIR]')) { kind = 'file-dir'; rest = raw.substring(5) }
		else continue
		while (rest.startsWith(' ') || rest.startsWith('\t')) rest = rest.substring(1)
		if (rest.length === 0) continue
		count++
		if (rows.length < MAX_ROWS) rows.push(row(kind, '', '', rest))
		else truncated = true
	}
	if (count === 0) return { view: '', rows: [], truncated: false } as ToolDetail
	rows.unshift(row('summary', '', '', summary(count)))
	return { view: 'files', rows: rows, truncated: truncated } as ToolDetail
}

/** 浅底等宽文件体（PC renderHighlightedFile / renderTodoMarkdown：移动端无 hljs，
 *  按等宽原文逐行展示——底色/内距/字体与 PC .tool-file-pre 同口径）。 */
function fileBody(text: string): ToolDetail {
	const rows: ToolDetailRow[] = []
	const lines = text.split('\n')
	let truncated = false
	for (let i = 0; i < lines.length; i++) {
		if (rows.length >= MAX_ROWS) { truncated = true; break }
		rows.push(row('plain', '', '', lines[i]))
	}
	return { view: 'file', rows: rows, truncated: truncated } as ToolDetail
}

/** 分发入口（PC renderToolBody 同序）：ANSI 削离 → 专用投影 → 兜底 plain。
 *  labels：noOutput/editFailed 词条值 + grep/files 汇总文案构造函数由调用方注入。 */
export function toolDetailOf(bareTool: string, body: string, argsDiff: string, argsOld: string, argsNew: string,
	command: string, todos: string, failed: boolean,
	noOutput: string, editFailed: string,
	grepSummary: (files: number, hits: number) => string, itemsSummary: (n: number) => string): ToolDetail {
	const text = stripAnsi(body)
	if (bareTool === 'edit') {
		let diff = argsDiff
		let result = text
		if (diff.length === 0 && result.startsWith('---')) { diff = result; result = '' }
		if (diff.length === 0) diff = synthesizeEditDiff(argsOld, argsNew, result)
		const d = editDetail(diff, result, failed, editFailed)
		if (d.rows.length > 0) return d
	} else if (bareTool === 'bash' || bareTool === 'bash_output') {
		return bashDetail(command, text, noOutput)
	} else if (bareTool === 'grep') {
		const d = grepDetail(text, grepSummary)
		if (d.view.length > 0) return d
	} else if (bareTool === 'glob' || bareTool === 'ls') {
		const d = fileListing(text, itemsSummary)
		if (d.view.length > 0) return d
	} else if (bareTool === 'read' || bareTool === 'write') {
		if (text.length > 0) return fileBody(text)
	} else if (bareTool === 'todowrite' || bareTool === 'todoread' || bareTool === 'todo') {
		// PC：todowrite 优先取入参 todos 原文（markdown 符号保真），todoread 取返回值
		const md = todos.trim().length > 0 ? todos : text
		if (md.trim().length > 0) return fileBody(md)
	}
	// 兜底（PC .tool-plain-out）：思考全文/其余工具/未命中投影的结果原文
	if (text.length === 0) return { view: 'plain', rows: [], truncated: false } as ToolDetail
	return fileBody(text)
}

/** 展开卡体估算高度（px）——批次限高窗 windowStyle 的显式高度依据。
 *
 * 【2026-11-27 用户报障「展开后大片空白」真因】旧估算按「每 40 字符一行 18px」
 * 折算 body 原文：与真实渲染几何完全脱节——
 *  - edit：渲染的是 args.diff/old+new 合成（body 只是短结果句），估高漏掉整个 diff；
 *  - bash/todo：渲染 commandRaw/todosRaw 优先，body 长度不代表卡体；
 *  - grep/glob/ls：投影会丢弃非命中行/空行，按原文折算虚高一大截；
 *  - 长行折行（等宽 12px ≈ 7.2px/字符）未计入；卡体 8/14 内距 + 外边距漏计。
 * scroll-view 高度必须显式给定（vapor 无自然收缩），估算虚高即容器底部整段空白。
 *
 * 本函数与 app-tool-detail.uvue 的渲染几何逐行同源：先走同一 toolDetailOf 投影
 * 拿到真实行集，再按每类行的字号/行高/外边距/折行折算。纯函数（文案参数注入），
 * verify 可 node 直跑断言「估算 ≈ 渲染几何」。调用方保证 body 非空才计入
 * （模板 v-if 同条件）；bash 特例：无 command 且 body 空时组件仍渲染 no_output，
 * 由调用方按渲染条件决定是否计入。 */
export function toolDetailHeight(bareTool: string, body: string, argsDiff: string, argsOld: string, argsNew: string,
	command: string, todos: string, failed: boolean, noOutput: string, editFailed: string,
	grepSummary: (files: number, hits: number) => string, itemsSummary: (n: number) => string,
	availWidth: number): number {
	const d = toolDetailOf(bareTool, body, argsDiff, argsOld, argsNew, command, todos, failed,
		noOutput, editFailed, grepSummary, itemsSummary)
	/* 等宽 12px 字符宽 ≈ 7.2px，向上取整 8：宁可估高 1 行也不裁掉半行 */
	const charW = 8
	const wrapped = (len: number, width: number): number => {
		const perLine = Math.max(1, Math.floor(width / charW))
		return Math.max(1, Math.ceil(len / perLine))
	}
	/* 卡体内容可用宽 = 窗宽 - 卡体左右内距 28 */
	const boxW = Math.max(60, availWidth - 28)
	let h = 0
	for (let i = 0; i < d.rows.length; i++) {
		const r = d.rows[i]
		if (r.kind === 'diff-add' || r.kind === 'diff-del' || r.kind === 'diff-ctx') {
			/* 双列行号 32×2 + 符号字符 */
			h += wrapped(r.text.length + 1, boxW - 64) * 18
		} else if (r.kind === 'diff-hunk' || r.kind === 'diff-head') {
			h += wrapped(r.text.length, boxW) * 18
		} else if (r.kind === 'bash-cmd') {
			h += wrapped(r.text.length + 2, boxW) * 18 + 4
		} else if (r.kind === 'grep-file') {
			h += wrapped(r.text.length, boxW) * 18 + 4
		} else if (r.kind === 'grep-hit') {
			h += wrapped(r.text.length, boxW - 36) * 18
		} else if (r.kind === 'grep-note') {
			h += wrapped(r.text.length, boxW) * 16
		} else if (r.kind === 'file' || r.kind === 'file-dir') {
			h += wrapped(r.text.length, boxW - 18) * 18
		} else if (r.kind === 'summary') {
			h += wrapped(r.text.length, boxW) * 16 + 4
		} else if (r.kind === 'result' || r.kind === 'result-error') {
			h += wrapped(r.text.length, boxW) * 18 + 4
		} else {
			h += wrapped(r.text.length, boxW) * 18
		}
	}
	if (d.truncated) h += 18
	/* 卡体上下内距 16 + 组件外边距 2/6 */
	return h + 24
}