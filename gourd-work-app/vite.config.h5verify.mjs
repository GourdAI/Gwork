// 临时 H5 联调配置（仅本机验证用，不参与打包）：
// 继承主配置，加一个后置 transform，把 rice-ui 库经 UTS→TS 转译后残留的
// `for (let key = null in css)`（UTS for-in 写法，JS 非法）改写为合法 JS。
// App 原生打包走 HBuilderX（不经 vite transform），不受影响。
import base from './vite.config.js'

function fixUtsForIn() {
	return {
		name: 'h5verify-fix-uts-for-in',
		enforce: 'post',
		transform(code, id) {
			if (!/\.uts|\.uvue/.test(id)) return null
			if (id.includes('basic.uts')) console.log('[h5verify] transform hit:', id)
			if (!/for\s*\(\s*(?:const|let|var)\s+\w+\s*=\s*[^)]*\s+in\s/.test(code)) return null
			const out = code.replace(
				/for\s*\(\s*(const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*[^)]+?\s+in\s/g,
				'for ($1 $2 in '
			)
			return out === code ? null : { code: out, map: null }
		}
	}
}

export default async (env) => {
	const cfg = typeof base === 'function' ? await base(env) : base
	cfg.plugins = [...(cfg.plugins || []), fixUtsForIn()]
	return cfg
}