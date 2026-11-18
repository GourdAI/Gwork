/**
 * GWork 官方账号后端配置（gourd-work-admin / new-api）。
 *
 * 与桌面端 src-tauri/src/auth.rs 同一套后端：国内 / 国际双站点，
 * 启动后竞速探测 /api/status，谁先返回有效 JSON 就锁定谁，
 * 会话 Cookie 与刷新令牌全程不跨站重放。
 *
 * 地址经 .env.* 的 __ENV__ 注入；H5 开发走 vite 代理规避浏览器跨域。
 */
declare const __ENV__: Record<string, string>

/** 站点根地址（无 /api 后缀）：原生端直连；H5 端经代理时用代理前缀代替 */
export const GWORK_HOSTS: string[] = [
	__ENV__.VITE_GWORK_HOST_CN ?? 'https://www.gourd-ai.cn',
	__ENV__.VITE_GWORK_HOST_INTL ?? 'https://www.gourdwork.com'
]

/** 请求 base：H5 用代理前缀，原生端直连站点。先赋默认值再按平台覆写，
 * 避免条件编译双分支重复声明（tsc 不做条件编译，两个分支都会看到） */
let basesRaw: string[] = GWORK_HOSTS
// #ifdef WEB
/** H5：浏览器直连官方站点会被 CORS 拦截（登录/注册路由未挂 CORS），
 * 开发走 vite 的 /gwork-cn / /gwork-intl 代理；线上需网关按同前缀转发 */
basesRaw = [
	__ENV__.VITE_GWORK_PROXY_CN ?? '/gwork-cn',
	__ENV__.VITE_GWORK_PROXY_INTL ?? '/gwork-intl'
]
// #endif

export const GWORK_BASES: string[] = basesRaw

/** 站点真实 Origin（refresh/logout 的 SessionCookieOriginGuard 要求与 Host 同源） */
export function originOf(base: string): string {
	const idx = GWORK_BASES.indexOf(base)
	if (idx >= 0 && idx < GWORK_HOSTS.length) return GWORK_HOSTS[idx]
	return base
}

export const GWORK_REQUEST_TIMEOUT: number = parseInt(__ENV__.VITE_GWORK_REQUEST_TIMEOUT ?? '20000')