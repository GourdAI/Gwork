/* 品牌贴图再生成：与桌面端 gourd-work/desktop/ui/img/logo.svg 完全同源（黑底白 G）。
 * 产物（覆盖 gourd-work-app/static/）：
 *   logo.png               —— 首页主视觉/关于页：桌面端原始 logo（黑 tile + 白 G），1024
 *   logo-inverse.png       —— 暗色主题变体（白 tile + 黑 G，与暗色 accent 近白实底同构）
 *   login-mark-light.png   —— 登录页光晕合成（450 画布：中性光晕 + 300 tile）
 *   login-mark-dark.png    —— 同上暗色版
 *   avatar-default.png     —— 默认用户头像（实心圆角黑底 + 白 G，语义与主视觉区分）
 *   logos/logo_*.png       —— Android 密度图标 + iOS appstore（黑 tile 白 G，全出血）
 * 运行（依赖 sharp，项目未入库该依赖，临时装一份即可）：
 *   npm install --prefix .brand-tools sharp
 *   NODE_PATH=.brand-tools/node_modules node build/brand/gen-brand-assets.cjs
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..', '..');           // gourd-work-app/
const repoRoot = path.resolve(appRoot, '..');                   // 仓库根
const root = path.join(appRoot, 'static');
const desktopSvg = fs.readFileSync(path.join(repoRoot, 'gourd-work', 'desktop', 'ui', 'img', 'logo.svg'), 'utf8');
const paths = [...desktopSvg.matchAll(/<path fill="(#[0-9a-fA-F]{6})"[^>]*d="([^"]+)"/g)].map(m => ({ fill: m[1], d: m[2] }));
if (paths.length !== 2) throw new Error('logo.svg path count != 2: ' + paths.length);
const [tilePath, gPath] = paths; // 第一个是圆角方底，第二个是 G 字形

const svgOf = (tileFill, gFill) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
	`<path fill="${tileFill}" fill-rule="evenodd" d="${tilePath.d}"/>` +
	`<path fill="${gFill}" fill-rule="evenodd" d="${gPath.d}"/></svg>`;

const BLACK = '#18181b'; // 桌面端 graphite accent（亮）/ logo 黑底同源色系
const WHITE = '#ffffff';
const NEARWHITE = '#e4e4e7'; // 暗色 accent

async function main() {
	// 1) 首页主视觉：亮色黑 tile 白 G / 暗色白 tile 黑 G
	await sharp(Buffer.from(svgOf(BLACK, WHITE))).resize(1024, 1024).png().toFile(path.join(root, 'logo.png'));
	await sharp(Buffer.from(svgOf(NEARWHITE, BLACK))).resize(1024, 1024).png().toFile(path.join(root, 'logo-inverse.png'));

	// 2) 登录光晕合成：450 画布，radial 光晕 + 300 tile 居中。
	//    光晕取中性黑/白低透明度（替代原蓝色光晕），亮暗各一张。
	const halo = (rgb, aMax) => Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="450" height="450">` +
		`<defs><radialGradient id="g" cx="50%" cy="50%" r="50%">` +
		`<stop offset="0%" stop-color="rgba(${rgb},${aMax})"/>` +
		`<stop offset="55%" stop-color="rgba(${rgb},${(aMax * 0.45).toFixed(3)})"/>` +
		`<stop offset="100%" stop-color="rgba(${rgb},0)"/>` +
		`</radialGradient></defs><rect width="450" height="450" fill="url(#g)"/></svg>`);
	const tile300 = await sharp(Buffer.from(svgOf(BLACK, WHITE))).resize(300, 300).png().toBuffer();
	const tile300inv = await sharp(Buffer.from(svgOf(NEARWHITE, BLACK))).resize(300, 300).png().toBuffer();
	await sharp(halo('24,24,27', 0.14)).composite([{ input: tile300, left: 75, top: 75 }]).png().toFile(path.join(root, 'login-mark-light.png'));
	await sharp(halo('228,228,231', 0.16)).composite([{ input: tile300inv, left: 75, top: 75 }]).png().toFile(path.join(root, 'login-mark-dark.png'));

	// 3) 默认头像：黑底圆角 + 白 G（原为蓝渐变，改桌面端同源黑）
	const avatarSvg =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
		`<rect width="1024" height="1024" rx="280" fill="${BLACK}"/>` +
		`<g transform="translate(102,102) scale(0.8)"><path fill="${WHITE}" fill-rule="evenodd" d="${gPath.d}"/></g></svg>`;
	await sharp(Buffer.from(avatarSvg)).resize(240, 240).png().toFile(path.join(root, 'avatar-default.png'));

	// 4) 应用图标：黑 tile 白 G 全出血（Android 各密度 + iOS appstore 无透明通道）
	for (const size of [72, 96, 144, 192]) {
		await sharp(Buffer.from(svgOf(BLACK, WHITE))).resize(size, size).png().toFile(path.join(root, 'logos', `logo_${size}x${size}.png`));
	}
	await sharp(Buffer.from(svgOf(BLACK, WHITE))).resize(1024, 1024).flatten({ background: BLACK }).png().toFile(path.join(root, 'logos', 'logo_1024x1024.png'));

	console.log('brand assets regenerated ->', root);
}
main().catch(e => { console.error(e); process.exit(1); });