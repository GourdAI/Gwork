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
            proxyRes.headers['x-gwork-set-cookie'] = cookies.join('\n')
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
			host: "0.0.0.0",     // ← 关键！允许所有 IP 访问
            proxy: {
                // GWork 官方账号双站点代理（登录/注册路由未挂 CORS，H5 直连会被浏览器拦）。
                // 前缀与 .env.* 的 VITE_GWORK_PROXY_CN/INTL 一一对应，改一处要改两处。
                // cookieDomainRewrite 置空：Set-Cookie 的 Domain 改写为当前 host，
                // 让浏览器接受轮换后的 new_api_refresh（H5 刷新依赖它）。
                '/gwork-cn': {
                    target: envConfig.VITE_GWORK_HOST_CN,
                    ws: false,
                    changeOrigin: true,
                    cookieDomainRewrite: '',
                    rewrite: (path) => path.replace(/^\/gwork-cn/, ''),
                    configure: mirrorSetCookie
                },
                '/gwork-intl': {
                    target: envConfig.VITE_GWORK_HOST_INTL,
                    ws: false,
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
        // 解决警告You are running the esm-bundler build of vue-i18n.
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
