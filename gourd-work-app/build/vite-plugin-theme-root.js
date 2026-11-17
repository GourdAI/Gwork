/**
 * 构建期给每个页面的 <template> 包一层 <theme-root> 全局根容器。
 *
 * 目的：主题类由根容器统一挂载，页面里不必再 import useTheme、也不必在根节点写
 * :class="themeClass"，新增页面零样板代码。
 *
 * 思路来自 uview-plus 的 UniUpRoot（uni-app 版），但这里是零第三方依赖的重写：
 * 本项目 node_modules 只有 @types/uts，vite / vue / magic-string 全部由 HBuilderX 自带，
 * 插件不能 import 它们，否则 CLI 构建时会解析失败。因此不使用 SFC 解析器与 MagicString，
 * 改为按深度扫描定位顶层 <template> 的配对标签，直接做字符串拼接（无 sourcemap）。
 *
 * fail-safe：定位不到顶层 <template>（例如 <script> 写在 <template> 之前）时原样返回，
 * 绝不产出半成品代码。
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const TAG = 'theme-root'

function normalizePath(path) {
	return path.split('\\').join('/').replace(/\?.*$/, '')
}

/**
 * 从 pages.json 抓页面文件绝对路径。
 * pages.json 允许 // 注释，JSON.parse 会直接抛错，所以只按 path 字段做正则提取。
 */
function readPageFiles(root, excludePages) {
	const files = new Set()
	const excluded = new Set()
	let text = ''
	try {
		text = readFileSync(resolve(root, 'pages.json'), 'utf-8')
	} catch (error) {
		console.warn(`[theme-root] 读取 pages.json 失败，跳过注入：${error.message}`)
		return { files, excluded }
	}
	for (const page of excludePages) {
		excluded.add(normalizePath(isAbsolute(page) ? page : resolve(root, page)))
	}
	const pattern = /"path"\s*:\s*"([^"]+)"/g
	let matched = pattern.exec(text)
	while (matched !== null) {
		const pagePath = matched[1]
		// 只处理项目自有页面：@/ 开头的别名路径，以及 uni_modules 里的插件页面（第三方只读，
		// 例如 pages.json 注册的 rice-ui 演示页）都不注入
		if (!pagePath.startsWith('@/')) {
			const absolute = normalizePath(isAbsolute(pagePath) ? pagePath : resolve(root, pagePath))
			if (!absolute.startsWith(`${normalizePath(root)}/uni_modules/`)) {
				files.add(`${absolute}.uvue`)
			}
		}
		matched = pattern.exec(text)
	}
	return { files, excluded }
}

/**
 * 找到顶层 <template> 块并包上 <theme-root>。
 * 只在 <script> / <style> 之前的区域里找，避免匹配到脚本字符串或样式内容。
 */
function wrapTemplate(code) {
	let limit = code.length
	const scriptAt = code.search(/<script[\s>]/)
	const styleAt = code.search(/<style[\s>]/)
	if (scriptAt >= 0) limit = Math.min(limit, scriptAt)
	if (styleAt >= 0) limit = Math.min(limit, styleAt)

	const head = code.slice(0, limit)
	const openAt = head.search(/<template[\s>]/)
	if (openAt < 0) return null
	const openEnd = head.indexOf('>', openAt)
	if (openEnd < 0) return null

	// 页面里可能嵌套 <template v-if> / <template #slot>，按深度找真正配对的那个
	const token = /<template[\s>]|<\/template>/g
	token.lastIndex = openEnd + 1
	let depth = 1
	let closeAt = -1
	let matched = token.exec(head)
	while (matched !== null) {
		if (matched[0] === '</template>') {
			depth -= 1
			if (depth === 0) {
				closeAt = matched.index
				break
			}
		} else {
			depth += 1
		}
		matched = token.exec(head)
	}
	if (closeAt < 0) return null

	// 不插入任何换行：转换前后行数完全一致，报错行号天然对齐，因此不需要 sourcemap
	// （这也是本插件不依赖 magic-string 的原因）
	return `${code.slice(0, openEnd + 1)}<${TAG}>${code.slice(openEnd + 1, closeAt)}</${TAG}>${code.slice(closeAt)}`
}

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled=true] 关掉即回到「每页手写 :class="themeClass"」的老方式
 * @param {string[]} [options.excludePages] 不注入的页面，相对项目根的路径（带不带 .uvue 都行）
 */
export default function themeRootPlugin(options = {}) {
	const enabled = options.enabled !== false
	const excludePages = options.excludePages || []
	let pageFiles = new Set()
	let excludedFiles = new Set()

	return {
		name: 'gwork-theme-root',
		enforce: 'pre',
		configResolved(config) {
			if (!enabled) return
			const scanned = readPageFiles(config.root, excludePages)
			pageFiles = scanned.files
			excludedFiles = scanned.excluded
			console.log(`[theme-root] 已为 ${pageFiles.size} 个页面注入 <${TAG}> 根容器`)
		},
		transform(code, id) {
			if (!enabled || pageFiles.size === 0) return null
			// 带 ? 的是 SFC 子块请求（?vue&type=template 等），只在整文件请求上注入一次
			if (id.includes('?')) return null
			const clean = normalizePath(id)
			if (!pageFiles.has(clean)) return null
			const withoutExt = clean.replace(/\.uvue$/, '')
			if (excludedFiles.has(clean) || excludedFiles.has(withoutExt)) return null
			const wrapped = wrapTemplate(code)
			if (wrapped === null) {
				console.warn(`[theme-root] 未找到顶层 <template>，已跳过：${clean}`)
				return null
			}
			return { code: wrapped, map: null }
		}
	}
}
