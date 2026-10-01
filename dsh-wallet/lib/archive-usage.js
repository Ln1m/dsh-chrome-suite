// dsh-wallet —— 存档会话日志的容器解码（只读，不碰活动区）。
//
// 容器：<archiveRoot>\<workspace>\<yyyy-MM>\<sessionId>.zip
//       zip 内唯一条目 = <sessionId>/session.v{3,4}.jsonl.zstd（zip 用 deflate；Node 无内置 zip 解析，这里自己读中央目录）
// 坑：.jsonl.zstd 是「多段独立 zstd 帧」串联（每次落盘一帧），Node 的 zstdDecompressSync /
//     createZstdDecompress 都只解第一帧（只拿到 session 头）。这里按帧魔数 28b52ffd 对每个候选
//     偏移单独解一次，用输出首字符 '{' 过滤伪命中，再按偏移顺序拼接。

import { open, readdir } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LH_SIG = 0x04034b50;
const EOCD_SCAN_MAX = 66000;

/** 递归列出存档目录下的 zip（含 <workspace>/<yyyy-MM>/ 两级）。目录不存在时返回空数组。 */
export async function listArchiveZips(root, acc) {
  const out = acc || [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) await listArchiveZips(p, out);
    else if (entry.isFile() && entry.name.endsWith(".zip")) out.push(p);
  }
  return out;
}

/** 中央目录里第一条目的元信息（不解压正文）：{ name, method, csize, usize, mtime, lhOff }。 */
async function firstEntryInfo(fh, size) {
  const tailLen = Math.min(size, EOCD_SCAN_MAX);
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) { if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; } }
  if (eocd < 0) return null;
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);
  if (cdSize <= 0 || cdSize > size) return null;
  const cd = Buffer.alloc(cdSize);
  await fh.read(cd, 0, cdSize, cdOff);
  if (cd.readUInt32LE(0) !== CD_SIG) return null;
  const method = cd.readUInt16LE(10);
  const dosTime = cd.readUInt16LE(12);
  const dosDate = cd.readUInt16LE(14);
  const csize = cd.readUInt32LE(20);
  const usize = cd.readUInt32LE(24);
  const nameLen = cd.readUInt16LE(28);
  const extraLen = cd.readUInt16LE(30);
  const cmtLen = cd.readUInt16LE(32);
  const lhOff = cd.readUInt32LE(42);
  const name = cd.toString("utf8", 46, 46 + nameLen);
  const mtime = Date.UTC(1980 + (dosDate >> 9), ((dosDate >> 5) & 0xf) - 1, dosDate & 0x1f, dosTime >> 11, (dosTime >> 5) & 0x3f, (dosTime & 0x1f) * 2);
  return { name, method, csize, usize, mtime, lhOff };
}

/** 只读元信息（用于按时间窗筛选，不解压）。 */
export async function readArchiveEntryInfo(zipPath) {
  const fh = await open(zipPath, "r");
  try {
    const st = await fh.stat();
    const info = await firstEntryInfo(fh, st.size);
    return info ? { name: info.name, mtime: info.mtime, usize: info.usize } : null;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

/** 多段 zstd 逐帧解（导出以便离线校验这个坑）。 */
export function decodeZstdFrames(buf) {
  const parts = [];
  let pos = buf.indexOf(ZSTD_MAGIC, 0);
  while (pos >= 0 && pos < buf.length) {
    let out = null;
    try { out = zlib.zstdDecompressSync(buf.subarray(pos)); } catch { out = null; }
    if (out && out.length > 0 && out[0] === 0x7b) parts.push(out);
    pos = buf.indexOf(ZSTD_MAGIC, pos + 4);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** 完整读出并解码一个存档会话：返回 { name, mtime, text }；损坏/异常返回 null。 */
export async function readArchiveSession(zipPath) {
  const fh = await open(zipPath, "r");
  try {
    const st = await fh.stat();
    const info = await firstEntryInfo(fh, st.size);
    if (!info || info.csize <= 0) return null;
    const lh = Buffer.alloc(30);
    await fh.read(lh, 0, 30, info.lhOff);
    if (lh.readUInt32LE(0) !== LH_SIG) return null;
    const dataOff = info.lhOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = Buffer.alloc(info.csize);
    await fh.read(raw, 0, info.csize, dataOff);
    const payload = info.method === 8 ? zlib.inflateRawSync(raw) : raw;
    return { name: info.name, mtime: info.mtime, text: decodeZstdFrames(payload) };
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

/** JSONL → 事件对象数组（解析失败的行跳过）。 */
export function parseJsonlEvents(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const s = line.trim();
    if (s.length === 0 || s[0] !== "{") continue;
    try { out.push(JSON.parse(s)); } catch { /* 截断行等，跳过 */ }
  }
  return out;
}

/** 流式遍历事件：只对「会话头 / assistant/message」这两类行做 JSON.parse，
 *  其余（tool/result 等大体量行）用子串预筛直接跳过——整份 1196MB 存档的解析时间主要花在这里。 */
export function eachArchiveEvent(text, visit) {
  for (const line of String(text || "").split("\n")) {
    if (line.length < 24 || line.charCodeAt(0) !== 0x7b) continue;
    if (line.indexOf('"type":"session"') < 0 && line.indexOf('"assistant/message"') < 0) continue;
    let ev = null;
    try { ev = JSON.parse(line); } catch { continue; }
    visit(ev);
  }
}
