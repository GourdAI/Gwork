// vite.config.js
import {defineConfig, loadEnv} from 'vite';
import uni from '@dcloudio/vite-plugin-uni';
import {resolve} from 'path';
import themeRootPlugin from './build/vite-plugin-theme-root.js';
// import AutoImport from 'unplugin-auto-import/vite';
// import Components from '@uni-helper/vite-plugin-uni-components'
// import { codeInspectorPlugin } from 'code-inspector-plugin';

const alias = {
    '~': `${resolve(__dirname, './')}`,
    '@/': `${resolve(__dirname, './')}`
}

// H5 浏览器把 Set-Cookie 从 XHR 响应头里剥掉（forbidden response header），
// uni.request 的 header 里永远拿不到 new_api_refresh —— 登录会一直报「缺少会话凭据」。
// 代理层把 Set-Cookie 原样镜像到自定义可读头 X-Gwork-Set-Cookie，客户端兜底读取。
// 生产部署的网关必须做同样的镜像（见 AGENTS.md / gwork-request.ts 注释），否则线上 H5 登录同样失败。
function mirrorSetCookie(proxy) {
    proxy.on('proxyRes', (proxyRes) => {
        const cookies = proxyRes.headers['set-cookie']
        if (cookies != null && cookies.length > 0) {
            // HTTP 头值不允许裸换行（Node setHeader 抛 ERR_INVALID_CHAR 崩 dev server）；
            // 用 ", " 连接（Set-Cookie 多值惯例），客户端 split('\n') 得单行也能逐行解析。
            proxyRes.headers['x-gwork-set-cookie'] = cookies.join(', ')
        }
    })
}

export const r = (...args) => resolve(__dirname, '.', ...args)


// 读取证书（仅在开发环境）
const isDev = process.env.NODE_ENV === 'development'

export default defineConfig(({mode}) => {
	const envConfig = loadEnv(mode, __dirname);
    return {
        base: '/',
        plugins: [
            themeRootPlugin({
                enabled: true,
                excludePages: []  // 需要排除的页面路径，例如 ['pages/special/index']
            }),
            uni(),
            h5verifyFixUtsForIn,
            vueI18nFeatureFlags,
			/*AutoImport({
				imports: ['vue', 'uni-app'],
                include: [
                    /\.[jt]sx?$/,
                    /\.vue$/,
                    /\.vue\?vue/,
                    /\.nvue$/,
                    /\.nvue\?vue/,
                    /\.md$/
                ],
				dts: r('auto-imports.d.ts')
			}),*/
			/*codeInspectorPlugin({
				bundler: 'vite'
			})*/
        ],
        server: {
            base: envConfig.VITE_BASE_PATH,
            port: envConfig.VITE_PORT,
            // 只绑回环：这个 dev server 带着双站点代理（下面 proxy 段）会把
            // `/gwork-cn` 转发到官方 API 并镜像 Set-Cookie 到可读头，绑 0.0.0.0
            // 等于把「用你的开发端口借道访问官方 API + 读取 refresh token」开放给
            // 同网段任何人。真机调试用 VITE_DEV_HOST 显式指定本机网卡。
            host: envConfig.VITE_DEV_HOST || "127.0.0.1",
            proxy: {
                // GWork 官方账号双站点代理（登录/注册路由未挂 CORS，H5 直连会被浏览器拦）。
                // 前缀与 .env.* 的 VITE_GWORK_PROXY_CN/INTL 一一对应，改一处要改两处。
                // cookieDomainRewrite 置空：Set-Cookie 的 Domain 改写为当前 host，
                // 让浏览器接受轮换后的 new_api_refresh（H5 刷新依赖它）。
                '/gwork-cn': {
                    target: envConfig.VITE_GWORK_HOST_CN,
                    // 设备中转 WS（/api/gwork/link）与 REST 同前缀转发
                    ws: true,
                    changeOrigin: true,
                    cookieDomainRewrite: '',
                    rewrite: (path) => path.replace(/^\/gwork-cn/, ''),
                    configure: mirrorSetCookie
                },
                '/gwork-intl': {
                    target: envConfig.VITE_GWORK_HOST_INTL,
                    ws: true,
                    changeOrigin: true,
                    cookieDomainRewrite: '',
                    rewrite: (path) => path.replace(/^\/gwork-intl/, ''),
                    configure: mirrorSetCookie
                }
            }
        },
        resolve: {
            alias
        },
        build: {
        },
        // 解决警告 You are running the esm-bundler build of vue-i18n.
        // 注意：define 只负责常规替换；HBuilderX 内置 vite 若对 node_modules 预构建产物
        // 不做 define 替换，由下方 vueI18nFeatureFlags 插件在 transform 层兜底（双保险）。
        define: {
            __VUE_I18N_FULL_INSTALL__: true,
            __VUE_I18N_LEGACY_API__: false,
            __VUE_I18N_PROD_DEVTOOLS__: false,
            __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
            // 一次性把全部环境变量注入到全局 __ENV__
            __ENV__: JSON.stringify(envConfig)
        }
    }
});

// vue-i18n esm-bundler 特性旗标兜底替换（消除 "You are running the esm-bundler build of vue-i18n" 告警）。
// 病根：vue-i18n 9.x 的 initFeatureFlags() 发现旗标全局未被替换成布尔字面量
// （typeof __VUE_I18N_*__ !== 'boolean'）就在 dev 下 console.warn。
// 主配置 define 已给出同一组旗标，但 HBuilderX 内置 vite 版本不可控，
// define 对 node_modules（含预构建产物）的替换不保证生效——本插件在 transform 层
// 对 vue-i18n / @intlify 的 esm 产物做同样的字面量替换，与 define 双保险。
// 值与 locale/i18n.ts 口径一致：legacy:false（项目只用 Composition API）、全量安装、关生产 devtools。
const vueI18nFeatureFlags = {
    name: 'gwork-vue-i18n-feature-flags',
    enforce: 'pre',
    transform(code, id) {
        const file = id.split('?')[0].replace(/\\/g, '/')
        if (!/node_modules\/(vue-i18n|@intlify\/[^/]+)\//.test(file)) return null
        if (!/\.(m?js|ts)$/.test(file)) return null
        if (!/__VUE_I18N_|__INTLIFY_/.test(code)) return null
        let out = code
            .replace(/\b__VUE_I18N_FULL_INSTALL__\b/g, 'true')
            .replace(/\b__VUE_I18N_LEGACY_API__\b/g, 'false')
            .replace(/\b__VUE_I18N_PROD_DEVTOOLS__\b/g, 'false')
            .replace(/\b__INTLIFY_PROD_DEVTOOLS__\b/g, 'false')
        // 旗标已字面量化后，initFeatureFlags 里恒假的 typeof 分支与 needWarn 告警块是死代码，
        // 整函数体置空（仅 esm-bundler 产物含此函数）。不依赖 minifier 的 DCE 能力，
        // dev / 生产任何构建下都保证不再打这条告警。
        out = out.replace(/function initFeatureFlags\(\)\s*\{[\s\S]*?\n\}/, 'function initFeatureFlags() {}')
        return out === code ? null : { code: out, map: null }
    }
}

// [h5verify] 本机 H5 联调临时修正：rice-ui 经 UTS→TS 转译后残留
// `for (let key = null in css)`（UTS for-in 写法，JS 非法）→ 改写为合法 JS。
// App 原生打包不经此 transform，不受影响；联调结束可整段删除。
const h5verifyFixUtsForIn = {
    name: 'h5verify-fix-uts-for-in',
    enforce: 'post',
    transform(code, id) {
        if (!/\.uts|\.uvue/.test(id)) return null
        const out = code.replace(/for\s*\(\s*(const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*null\s+in\s/g, 'for ($1 $2 in ')
        return out === code ? null : { code: out, map: null }
    }
}
