import App from './App.uvue'

import { createSSRApp } from 'vue'
import './styles/theme.scss'

// #ifdef WEB
// 开启样式隔离 2.0 后 H5 端取不到 App.uvue 的全局样式，rice-ui 基础样式改在此引入（见其 readme 第 3 节）
// @ts-ignore
import "@/uni_modules/rice-ui/libs/style/index.css";
// #endif

export function createApp() {
	const app = createSSRApp(App)
	return {
		app
	}
}