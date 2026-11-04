/* 极简 PNG 解码（仅支持本仓库二维码的实际形态：非交织、8bit、colorType 2/6）。
   目的：把「扫码静区是否达标」变成可回归计算的事实，而不是靠注释里的一句「应该够」。
   仅测试内联使用，不引入 playwright 等外部依赖（与仓库 test/js 的自制桩风格一致）。 */
const zlib = require('node:zlib');

function decodePng(buf) {
  if (buf.slice(1, 8).toString('hex') !== '504e470d0a1a0a') throw new Error('非 PNG');
  let off = 8, ihdr = null, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const body = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = { w: body.readUInt32BE(0), h: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('缺 IHDR');
  if (ihdr.depth !== 8 || ihdr.interlace !== 0 || (ihdr.color !== 2 && ihdr.color !== 6)) {
    throw new Error(`不支持的 PNG 形态 depth=${ihdr.depth} color=${ihdr.color} interlace=${ihdr.interlace}`);
  }
  const ch = ihdr.color === 6 ? 4 : 3;
  const stride = ihdr.w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(ihdr.h * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let pos = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[pos++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const v = raw[pos++];
      const a = x >= ch ? row[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let val;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: val = v + paeth(a, b, c); break;
        default: throw new Error('未知 filter ' + filter);
      }
      row[x] = val & 0xff;
    }
  }
  return { w: ihdr.w, h: ihdr.h, ch, stride, data: out };
}

/** 亮度（Rec.601）；无 alpha 通道概念——本图 alpha 恒 255，由调用方自检。 */
function lumOf(img, x, y) {
  const i = y * img.stride + x * img.ch;
  const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 提取二维码的结构度量：暗区包围盒、四周白边、以及推断出的模块边长。 */
function measureQr(img, darkThreshold = 170) {
  const { w, h } = img;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (lumOf(img, x, y) < darkThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('未找到任何暗色模块');
  const codeW = maxX - minX + 1, codeH = maxY - minY + 1;

  // 最小暗游程 = 1 模块宽度的估计：跨多条扫描线取最小值，避免单条线恰好没有 1 模块游程
  let minRun = Infinity;
  const lines = [0.5, 0.3, 0.7, 0.15, 0.85].map(f => Math.floor(minY + codeH * f));
  for (const y of lines) {
    let inRun = false, len = 0;
    for (let x = minX; x <= maxX; x++) {
      if (lumOf(img, x, y) < darkThreshold) { len = inRun ? len + 1 : 1; inRun = true; }
      else if (inRun) { inRun = false; if (len < minRun) minRun = len; }
    }
  }
  if (!Number.isFinite(minRun)) throw new Error('未扫到暗游程');

  // 模块数必须落在合法 QR 版本上：modules = 21 + 4*version（version>=1），
  // 用包围盒宽除以游程估计再对齐到最近的合法值，可消除游程估计的偏差。
  const guess = codeW / minRun;
  const version = Math.max(1, Math.round((guess - 21) / 4));
  const modules = 21 + 4 * version;
  return {
    w, h, minX, minY, maxX, maxY, codeW, codeH,
    margin: { left: minX, right: w - 1 - maxX, top: minY, bottom: h - 1 - maxY },
    minRun, version, modules,
    moduleSize: codeW / modules,
    minMarginPx: Math.min(w - 1 - maxX, minX, h - 1 - maxY, minY),
    quietModulesInImage: Math.min(w - 1 - maxX, minX, h - 1 - maxY, minY) / (codeW / modules),
  };
}

/**
 * 渲染后总静区（模块数）= 图内自带白边 + 承载卡片内边距（换算回原图像素），再除以模块边长。
 * displayWidth 为 <img> 的 CSS 显示宽，padding 为白卡内边距。
 */
function quietModulesAfterRender(m, displayWidth, cardPadding) {
  const scale = displayWidth / m.w;
  const paddingInSourcePx = cardPadding / scale;
  return (m.minMarginPx + paddingInSourcePx) / m.moduleSize;
}

module.exports = { decodePng, lumOf, measureQr, quietModulesAfterRender };
