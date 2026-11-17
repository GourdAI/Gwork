/**
 * AIOnly 模块配置：统一从 .env.* 经 vite define 注入的 __ENV__ 读取
 */
declare const __ENV__: Record<string, string>

// H5 走 vite dev 代理（VITE_API_PROXY）规避浏览器跨域；原生端没有同源限制，直连 VITE_API_URL
// #ifdef H5
const API_BASE_URL = __ENV__.VITE_API_PROXY
// #endif
// #ifndef H5
const API_BASE_URL = __ENV__.VITE_API_URL
// #endif

export const aionlyConfig = {
	baseUrl: API_BASE_URL,
	clientId: __ENV__.VITE_APP_CLIENT_ID,
	rsaPublicKey: __ENV__.VITE_APP_RSA_PUBLIC_KEY,
	hostname: __ENV__.VITE_AIONLY_HOSTNAME,
	tenantId: __ENV__.VITE_AIONLY_TENANT_ID,
	loginUrl: __ENV__.VITE_AIONLY_LOGIN_URL,
	requestTimeout: parseInt(__ENV__.VITE_AIONLY_REQUEST_TIMEOUT),
	pageSize: parseInt(__ENV__.VITE_AIONLY_PAGE_SIZE),
	maxPages: parseInt(__ENV__.VITE_AIONLY_MAX_PAGES)
}
