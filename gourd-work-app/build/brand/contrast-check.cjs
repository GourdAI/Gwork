/* 对比度核算：新色板关键配对（WCAG 相对亮度） */
const lum = hex => {
	const c = hex.replace('#', '');
	const v = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16) / 255)
		.map(x => x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
	return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const pairs = [
	['light 主按钮字', '#ffffff', '#18181b'],
	['dark 主按钮字', '#18181b', '#e4e4e7'],
	['light 正文', '#18181b', '#ffffff'],
	['dark 正文', '#e4e4e7', '#17171a'],
	['light 二级文字', '#71717a', '#ffffff'],
	['dark 二级文字', '#8f8f96', '#17171a'],
	['light 用户气泡字', '#18181b', '#f4f4f5'],
	['dark 用户气泡字', '#e4e4e7', '#232327'],
	['light error 文字', '#dc2626', '#ffffff'],
	['dark error 文字', '#f87171', '#17171a'],
	['light success 文字(新)', '#15803d', '#e6f6ed'],
	['dark success 文字', '#4ade80', '#1c3a2b'],
	['light 录音条反色字', '#ffffff', '#18181b'],
	['dark 录音条反色字', '#18181b', '#e4e4e7'],
	['light 品牌浅底主色字', '#18181b', '#ececee'],
	['dark 品牌浅底主色字', '#e4e4e7', '#2a2a2e'],
	['light hero 标题', '#18181b', '#ffffff'],
	['dark hero 标题', '#e4e4e7', '#17171a'],
	['light 连接器图标白 on #2f7df6', '#ffffff', '#2f7df6'],
	['dark 连接器图标白 on #2f7df6', '#ffffff', '#2f7df6'],
];
for (const [name, fg, bg] of pairs) {
	const r = ratio(fg, bg);
	console.log((r >= 4.5 ? 'AA  ' : r >= 3 ? 'AA-large/图形 ' : 'FAIL') + ' ' + r.toFixed(2) + '  ' + name);
}