#!/usr/bin/env node
// zip-store.mjs — 零依赖 zip 编解码（供 build-snapshot / verify-cli 共用）。
// 编码：store(0) + deflate(8) 双方法；文本类条目 deflate，二进制 store。
// 格式与内核 skills/market.rs build_zip 测试辅助同构（local header + central
// directory + EOCD，无 zip64、无 data descriptor），CRC32 为标准 IEEE。
// 内核 unpack_zip 支持方法 0/8、校验 CRC、拒绝 ../绝对路径——本编码器产物
// 必须能被其原样解包。时间戳固定 DOS epoch（1980-01-01），保证同内容同字节。
import zlib from 'node:zlib';

// ── CRC32（IEEE 802.3，反射多项式 0xEDB88320） ──────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── 路径安全（与内核 unpack_zip 的拒绝集同构） ──────────────────────────────
export function assertSafeZipPath(name) {
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\0')) {
    throw new Error('不安全的 zip 条目路径: ' + JSON.stringify(name));
  }
  if (name.split('/').some((seg) => seg === '..')) {
    throw new Error('不安全的 zip 条目路径（父目录穿越）: ' + JSON.stringify(name));
  }
}

const DEFLATE_EXT = new Set([
  '.md', '.txt', '.json', '.py', '.js', '.jsx', '.ts', '.css', '.html', '.htm',
  '.xml', '.svg', '.yml', '.yaml', '.csv', '.sh', '.sql',
]);
const DEFLATE_BASENAME = new Set(['LICENSE', 'NOTICE']);

function shouldDeflate(name, data) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')).toLowerCase() : '';
  if (!DEFLATE_BASENAME.has(base) && !DEFLATE_EXT.has(ext)) return false;
  if (data.length < 64) return false; // 小文件 deflate 反而更大
  return true;
}

// ── 编码 ────────────────────────────────────────────────────────────────────
// files: [{ name, data:Buffer }]，name 为 zip 内相对路径（正斜杠）。
// 返回 Buffer。排序由调用方保证（稳定字节输出）。
export function buildZip(files) {
  if (!files.length) throw new Error('空 zip 无意义（内核 unpack_zip 也拒绝空包）');
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    assertSafeZipPath(f.name);
    const name = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    let method = 0;
    let stored = data;
    if (shouldDeflate(f.name, data)) {
      const def = zlib.deflateRawSync(data, { level: 9 });
      if (def.length < data.length) { method = 8; stored = def; }
    }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0, 6);           // flags（无 UTF-8 位——名字全 ASCII；有非 ASCII 时置 0x800）
    if (name.some((b) => b > 0x7f)) lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);          // time: 00:00:00
    lh.writeUInt16LE(0x21, 12);       // date: 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(stored.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, name, stored);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(lh.readUInt16LE(6), 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(stored.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    // 30..37: extra len / comment len / disk / int attr = 0
    ch.writeUInt32LE(0, 38);          // external attr（普通文件）
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, name]));
    offset += lh.length + name.length + stored.length;
  }
  const cdOffset = offset;
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

// ── 解码（校验型：CRC / 偏移 / 路径安全全查） ────────────────────────────────
// 返回 [{ name, data }]。仅支持方法 0/8，与内核一致。
export function readZip(buf) {
  // EOCD：从尾部找签名（无注释时就在 len-22）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > eocd) throw new Error('central directory 越界');
  if (count === 0) throw new Error('空 zip');
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('central header 签名错误 @' + p);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (name.endsWith('/')) { p += 46 + nlen + elen + clen; continue; } // 目录条目
    assertSafeZipPath(name);
    p += 46 + nlen + elen + clen;
    // local header
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('local header 签名错误: ' + name);
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const stored = buf.subarray(start, start + csize);
    if (stored.length !== csize) throw new Error('条目截断: ' + name);
    let data;
    if (method === 0) data = Buffer.from(stored);
    else if (method === 8) data = zlib.inflateRawSync(stored);
    else throw new Error('不支持的压缩算法 ' + method + ': ' + name);
    if (data.length !== usize) throw new Error('解压尺寸不符: ' + name);
    if (crc32(data) !== crc) throw new Error('CRC 校验失败: ' + name);
    out.push({ name, data });
  }
  return out;
}