/* eslint-disable no-console */
/**
 * GWork uni-app-x 工程静态自检（零依赖，Node.js）
 * 运行：node tools/self-check.cjs
 *
 * 说明：pages.json 含 uni-app 条件编译注释 `// #ifdef APP-ANDROID || ...`，
 * 且条件块内对象带尾逗号，JSON.parse 前必须剥离注释与条件块；
 * 本脚本先做「条件块等价剥离 + 行注释剥离 + 尾逗号清理」，再 JSON.parse，
 * 并对「剥离后的结构」与实际文件分别做校验。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
	if (ok) {
		pass++;
		console.log('[PASS] ' + name + (detail ? ' :: ' + detail : ''));
	} else {
		fail++;
		console.log('[FAIL] ' + name + (detail ? ' :: ' + detail : ''));
	}
}
function read(rel) {
	return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function exists(rel) {
	return fs.existsSync(path.join(ROOT, rel));
}
/**
 * 剥离 JS/UTS 代码中的注释，但完整保留字符串字面量。
 * 用途：门禁与密钥检测只看「可执行代码」，避免把
 * 「不保留配对页门禁」「不接 uniCloud」这类说明性注释误判为违规。
 */
function stripCodeComments(text) {
	let out = '';
	let i = 0;
	let state = 'code'; // code | string | line | block
	let quote = '';
	while (i < text.length) {
		const c = text[i];
		const d = i + 1 < text.length ? text[i + 1] : '';
		if (state === 'code') {
			if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
			if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
			if (c === "'" || c === '"' || c === '`') { state = 'string'; quote = c; out += c; i++; continue; }
			out += c; i++; continue;
		}
		if (state === 'string') {
			out += c;
			if (c === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 2; continue; }
			if (c === quote) state = 'code';
			i++; continue;
		}
		if (state === 'line') {
			if (c === '\n' || c === '\r') { state = 'code'; out += c; i++; continue; }
			out += ' '; i++; continue;
		}
		// block
		if (c === '*' && d === '/') { out += '  '; i += 2; state = 'code'; continue; }
		out += (c === '\n' || c === '\r') ? c : ' ';
		i++;
	}
	return out;
}

/* ---------- 1. pages.json 宽松解析 ---------- */
const pagesRaw = read('pages.json');
// 剥离 // #ifdef ... // #endif 条件编译块（本工程只有 1 个 APP-* 块）
const withoutIfdef = pagesRaw.replace(/\/\/\s*#ifdef[\s\S]*?\/\/\s*#endif/g, '');
// 剥离其余以 // 开头的行注释（保留字符串内的 //，本项目路径无 //）
const noComments = withoutIfdef.split(/\r?\n/).filter((line) => !/^\s*\/\//.test(line)).join('\n');
// 清理对象/数组尾逗号
const jsonText = noComments.replace(/,(\s*[}\]])/g, '$1');
let pagesJson = null;
try {
	pagesJson = JSON.parse(jsonText);
	check('pages.json JSON.parse（剥离 // #ifdef 与 // 注释后）', true, jsonText.length + ' chars');
} catch (e) {
	check('pages.json JSON.parse（剥离 // #ifdef 与 // 注释后）', false, e.message);
}
if (pagesJson == null) {
	console.log('\n自检中止：pages.json 无法解析');
	process.exit(1);
}

/* ---------- 2. 启动首页 ---------- */
const pagePaths = pagesJson.pages.map((p) => p.path);
check('首个 page 为 pages/tasks/tasks（启动首页）', pagePaths[0] === 'pages/tasks/tasks', 'pages[0]=' + pagePaths[0]);
const expectedTabs = ['pages/tasks/tasks', 'pages/loop/loop', 'pages/discover/discover', 'pages/mine/mine'];
for (const p of expectedTabs) {
	check('4 个 tab 页均注册在 pages 中 :: ' + p, pagePaths.includes(p));
	check('4 个 tab 页存在对应 .uvue 文件 :: ' + p, exists(p + '.uvue'));
}

/* ---------- 3. tabBar ---------- */
const tabBar = pagesJson.tabBar;
check('tabBar 存在且恰有 4 项', !!tabBar && Array.isArray(tabBar.list) && tabBar.list.length === 4,
	tabBar ? 'list.length=' + tabBar.list.length : 'no tabBar');
check('tabBar 选中黑色 / 未选中灰色 / 浅色背景', tabBar.color === '#9b9ba2' && tabBar.selectedColor === '#141416' && tabBar.backgroundColor === '#fafafa',
	[tabBar.color, tabBar.selectedColor, tabBar.backgroundColor].join(' / '));
check('tabBar 无顶部分隔线（borderStyle: white）', tabBar.borderStyle === 'white');
const expectedTexts = ['任务', '定时任务', '发现', '我的'];
if (tabBar && Array.isArray(tabBar.list)) {
	const tabPaths = tabBar.list.map((t) => t.pagePath);
	check('4 个 tabBar.pagePath 顺序与 TABS 一致', JSON.stringify(tabPaths) === JSON.stringify(expectedTabs), tabPaths.join(','));
	const tabTexts = tabBar.list.map((t) => t.text);
	check('4 个 tabBar.text 与 mobile/js/data.js TABS 一致', JSON.stringify(tabTexts) === JSON.stringify(expectedTexts), tabTexts.join(','));
	for (const item of tabBar.list) {
		for (const key of ['iconPath', 'selectedIconPath']) {
			const rel = item[key];
			const ok = typeof rel === 'string' && exists(rel) && fs.readFileSync(path.join(ROOT, rel)).subarray(1, 4).toString('ascii') === 'PNG';
			check('icon 文件存在且为 PNG :: ' + rel, ok, ok ? fs.statSync(path.join(ROOT, rel)).size + ' bytes' : 'missing/invalid');
		}
	}
}

/* ---------- 4. 上游 3 个对话能力页保留 ---------- */
const chatPages = [
	'uni_modules/uni-ai-x/pages/index/index',
	'uni_modules/uni-ai-x/pages/common/webview/webview',
	'uni_modules/uni-ai-x/pages/select-text/select-text'
];
for (const p of chatPages) {
	check('上游对话能力页仍注册 :: ' + p, pagePaths.includes(p));
}

/* ---------- 5. 无 pair / 配对 强制跳转门禁 ---------- */
const gateFiles = ['App.uvue', 'pages.json', 'pages/tasks/tasks.uvue', 'pages/loop/loop.uvue',
	'pages/discover/discover.uvue', 'pages/mine/mine.uvue', 'uni_modules/uni-ai-x/config.uts'];
const gatePattern = /(?:\/pages\/pair|pages\/pair|pair\.uvue|配对页|reLaunch\s*\(|redirectTo\s*\(|navigateTo\s*\(\s*\{[^}]*pair)/i;
for (const rel of gateFiles) {
	// 先剥离代码注释，仅检测可执行代码；注释里的「不保留配对页」不算门禁
	const txt = stripCodeComments(read(rel));
	const m = txt.match(gatePattern);
	check('无 pair/配对 启动门禁（仅可执行代码）:: ' + rel, !m, m ? 'found: ' + m[0] : 'clean');
}
check('App.uvue onLaunch 调用 initWorkbuddyTheme（无其它跳转）', /onLaunch[\s\S]*?initWorkbuddyTheme\(\)/.test(read('App.uvue')));

/* ---------- 6. .uvue 无 Vue2-only 语法 ---------- */
const uvueFiles = expectedTabs.map((p) => p + '.uvue');
const vue2Patterns = [
	['Vue.prototype', /Vue\.prototype/],
	['this.$set', /this\.\$set\s*\(/],
	['filters:', /\bfilters\s*:/],
	['slot-scope', /slot-scope/],
	['$children', /\$children/],
	['<style scoped', /<style[^>]*scoped/],
	['100dvh', /100dvh/],
	[':root[data-theme]', /:root\[data-theme/],
	['v-html', /v-html/],
	['<script setup 缺失', /<script(?![^>]*lang="uts")[^>]*>/]
];
for (const rel of uvueFiles) {
	const txt = read(rel);
	const hits = vue2Patterns.filter(([, re]) => re.test(txt)).map(([n]) => n);
	check('UTS 语法合规（无 Vue2-only 写法）:: ' + rel, hits.length === 0, hits.length ? hits.join(',') : 'clean');
	check('使用 <script lang="uts" setup> :: ' + rel, /<script[^>]*lang="uts"[^>]*setup/.test(txt) || /<script[^>]*setup[^>]*lang="uts"/.test(txt));
	check('存在全视口根容器 gw-page-root :: ' + rel, txt.includes('gw-page-root'));
}

/* ---------- 7. config.uts 模型对齐 / 无密钥 ---------- */
const config = stripCodeComments(read('uni_modules/uni-ai-x/config.uts'));
const modelNames = ['快速', '均衡', '极致', 'Hy4 preview', 'Hy3', 'DeepSeek-V4.1-Flash', 'GLM-5.3', 'GLM-5.3-Flash'];
for (const n of modelNames) {
	check('config.uts 含 GWork 模型 :: ' + n, config.includes("name: '" + n + "'"));
}
check('config.uts 默认模型为 Hy3', /defaultLLM[\s\S]{0,160}model:\s*'gwork\/hy3'/.test(config));
check('config.uts currentUser 为 GWork 占位', /currentUser[\s\S]{0,200}gwork-placeholder/.test(config));
const secretPatterns = [/uniCloud/, /\bappId\s*:/, /\bsecret\s*:/, /webAuthUser\s*[=:]\s*['"]/, /webAuthPass\s*[=:]\s*['"]/];
const secretHits = secretPatterns.filter((re) => re.test(config)).map((re) => re.source);
check('config.uts 无硬编码密钥 / 无 uniCloud / 无 webAuthUser|Pass 赋值', secretHits.length === 0, secretHits.length ? secretHits.join(',') : 'clean');
// TODO 本身就是注释，需用原始文本检查；上面的 config 是剥离注释后的可执行代码
check('config.uts getToken 保留宿主注入 TODO', /getToken\(\)[\s\S]{0,1200}TODO\(GWork 后端\)/.test(read('uni_modules/uni-ai-x/config.uts')));

/* ---------- 8. 合规文件与素材 ---------- */
check('保留上游 license.md（Apache-2.0）', exists('license.md') && read('license.md').includes('Apache License'));
check('保留上游 README.md', exists('README.md'));
check('保留 uni-ai-x changelog.md', exists('uni_modules/uni-ai-x/changelog.md'));
check('保留 uni.scss 设计 token $gw-accent: #0fbc9b', read('uni.scss').includes('$gw-accent: #0fbc9b'));
check('复制工程不含 .git', !exists('.git'));
check('复制工程不含 node_modules', !exists('node_modules'));
// HBuilderX 云打包/编译会在工程根生成 unpackage/ 编译缓存（.gitignore 已忽略）。
// 断言不看「目录是否存在」，而看「是否被 gitignore 忽略 + 是否只含编译产物」：
// 源码副本不应提交构建产物，但本机编译后该目录存在是正常且必要的。
const gitignoreText = exists('.gitignore') ? read('.gitignore') : '';
const unpackageIgnored = /(^|\r?\n)\/?unpackage\/(\r?\n|$)/m.test(gitignoreText);
const unpackageOnlyBuild = !exists('unpackage/dist/build/app-plus') &&
	!exists('unpackage/release');
check('unpackage 构建缓存已被 .gitignore 忽略（编译产物不入库）',
	!exists('unpackage') || (unpackageIgnored && unpackageOnlyBuild));

console.log('\n---------------------------------------------');
console.log('pages 顺序: ' + pagePaths.join(' -> '));
console.log('tabBar: ' + (tabBar ? tabBar.list.map((t) => t.text + '=' + t.pagePath).join(' | ') : 'N/A'));
console.log('静态自检: ' + pass + ' PASS / ' + fail + ' FAIL');
console.log('---------------------------------------------');
process.exit(fail === 0 ? 0 : 1);
