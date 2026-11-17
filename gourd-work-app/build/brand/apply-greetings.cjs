/* 欢迎语词条移植（一次性迁移脚本，已执行过；桌面端标语更新后可重跑）：
 * 桌面端 app.welcome_greeting.0~19 → 移动端 home.greeting.0~19（扁平 key），12 语言成套。
 * 首次迁移时替换 home.title / home.subtitle（原固定标语）；重跑时原位覆盖已有 home.greeting.*。
 * 运行：node build/brand/apply-greetings.cjs（跑完必须 node build/verify-i18n.cjs 校验）
 */
const fs = require('fs');
const path = require('path');
const appRoot = path.resolve(__dirname, '..', '..');
const appLocale = path.join(appRoot, 'locale');
const deskLocale = path.resolve(appRoot, '..', 'gourd-work', 'desktop', 'ui', 'locales');
const map = { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' };
const langs = ['zh-Hans', 'zh-Hant', 'en', 'de', 'ja', 'ru', 'el', 'es', 'fr', 'pt', 'ro', 'vi'];

for (const lang of langs) {
	const deskFile = path.join(deskLocale, (map[lang] || lang) + '.json');
	const desk = JSON.parse(fs.readFileSync(deskFile, 'utf8'));
	const greetings = desk.app && desk.app.welcome_greeting;
	if (!greetings) throw new Error(deskFile + ' missing app.welcome_greeting');
	for (let i = 0; i < 20; i++) {
		if (typeof greetings[String(i)] !== 'string' || greetings[String(i)].length === 0) {
			throw new Error(deskFile + ' greeting.' + i + ' missing/empty');
		}
	}
	const file = path.join(appLocale, lang + '.json');
	const raw = fs.readFileSync(file, 'utf8');
	const pack = JSON.parse(raw);
	const firstRun = 'home.title' in pack;
	if (!firstRun && !('home.greeting.0' in pack)) throw new Error(file + ' missing home.title / home.greeting.0');
	// 原位替换：保持 key 顺序（verify-i18n 以 zh-Hans 顺序为基准）
	const out = {};
	for (const [k, v] of Object.entries(pack)) {
		if (k === 'home.title' || k === 'home.greeting.0') {
			for (let i = 0; i < 20; i++) out['home.greeting.' + i] = greetings[String(i)];
			continue;
		}
		if (k === 'home.subtitle') continue;
		if (/^home\.greeting\.\d+$/.test(k)) continue; // 重跑时统一在锚点处重建
		out[k] = v;
	}
	// 保持原文件缩进风格（tab）与末尾换行
	const body = JSON.stringify(out, null, '\t');
	fs.writeFileSync(file, body + (raw.endsWith('\n') ? '\n' : ''), 'utf8');
	console.log(lang, 'OK: 20 greetings, keys', Object.keys(out).length);
}
console.log('done');