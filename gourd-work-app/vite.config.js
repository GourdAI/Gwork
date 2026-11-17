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

export const r = (...args) => resolve(__dirname, '.', ...args)


// 读取证书（仅在开发环境）
const isDev = process.env.NODE_ENV === 'development'

export default defineConfig(({mode}) => {
	const envConfig = loadEnv(mode, __dirname);
		const yixiaoBase = new URL(envConfig.VITE_YIXIAO_BASE_URL);
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
                '/claw-app': {
                    target: envConfig.VITE_API_URL,
                    ws: false,
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/claw-app/, '')
                },
                '/yixiao-app': {
                    target: yixiaoBase.origin,
                    ws: false,
                    changeOrigin: true,
                    rewrite: (path) => path.replace(/^\/yixiao-app/, yixiaoBase.pathname.replace(/\/$/, ''))
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
