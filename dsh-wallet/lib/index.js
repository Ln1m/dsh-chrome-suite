// dsh-wallet —— Host 半端
// 学习 GitHub 项目（dsh-balance-meter / dsh-deepseek-quota / dsh-balance-plugin）的做法：
// 1) 查询官方 GET /user/balance（自动读 DSH 凭据 DEEPSEEK_API_KEY，失败指数退避重试）
// 2) 会话成本 = token-meter 的 tokenUsage 投影 × 官方价格表（flash/pro + 峰谷）
// 3) 今日消耗 / 历史趋势 = session/event 事件流聚合（历史经 sessionQuery 回扫）
// 4) 每个会话独立的消耗上限持久化到 ~/.dsh/dsh-wallet.json
// 浏览器只访问本机同源路由，Key 不出本机。

import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, delimiter as PATH_DELIMITER } from "node:path";
// 峰谷口径与节假日表只有一份，见 price-band.js（本机 scripts\token\dsh-usage-stats.mjs 也 import 它）
import { isPeakHour } from "./price-band.js";
// 存档会话日志的容器解码（zip → 多帧 zstd → JSONL），见文件头注释
import { listArchiveZips, readArchiveEntryInfo, readArchiveSession, eachArchiveEvent } from "./archive-usage.js";

export const name = "dsh-wallet";
export const inject = ["webServer", "sessions", "credentials", "sessionProjections", "sessionQuery"];

// —— 官方价格表（元 / 百万 token）——基础价（2026-08-17 前）——
const FLASH_COST = { inputPerMillion: 1, cacheReadPerMillion: 0.02, cacheWritePerMillion: 0, outputPerMillion: 2 };
const PRO_COST = { inputPerMillion: 3, cacheReadPerMillion: 0.025, cacheWritePerMillion: 0, outputPerMillion: 6 };

// 峰谷价（2026-08-17 00:00 北京时间起生效）
const FLASH_PEAK = {
  offPeak: { inputPerMillion: 1.5, cacheReadPerMillion: 0.05, cacheWritePerMillion: 0, outputPerMillion: 4.5 },
  peak: { inputPerMillion: 3.0, cacheReadPerMillion: 0.10, cacheWritePerMillion: 0, outputPerMillion: 9.0 },
};
// Flash 第二次调价（2026-09-10 12:00 北京时间起生效，官方定价页现行价）
const FLASH_PEAK_V2 = {
  offPeak: { inputPerMillion: 1, cacheReadPerMillion: 0.02, cacheWritePerMillion: 0, outputPerMillion: 4 },
  peak: { inputPerMillion: 2, cacheReadPerMillion: 0.04, cacheWritePerMillion: 0, outputPerMillion: 8 },
};
const PRO_PEAK = {
  offPeak: { inputPerMillion: 4.5, cacheReadPerMillion: 0.15, cacheWritePerMillion: 0, outputPerMillion: 13.5 },
  peak: { inputPerMillion: 9.0, cacheReadPerMillion: 0.30, cacheWritePerMillion: 0, outputPerMillion: 27.0 },
};

// 峰谷价生效时间：北京时间 2026-08-17 00:00 = UTC 2026-08-16 16:00
const PEAK_PRICING_START_MS = Date.UTC(2026, 7, 16, 16, 0, 0);
// Flash 第二次调价生效时间：北京时间 2026-09-10 12:00 = UTC 2026-09-10 04:00
const PEAK_PRICING_V2_START_MS = Date.UTC(2026, 8, 10, 4, 0, 0);

/** 由模型名判断计价档位（flash/pro）。 */
function pricingKeyOf(model) {
  if (typeof model !== "string") return "flash";
  const lower = model.toLowerCase();
  if (lower.includes("pro")) return "pro";
  return "flash";
}

function costOfTokens(count, perMillion) {
  if (!(count > 0) || !Number.isFinite(count)) return 0;
  return (count / 1000000) * perMillion;
}

/** 指定时刻生效的价格表：峰谷价生效后按北京时段取高峰/空闲，否则用基础价。 */
function effectiveCostAt(ts, pricingKey) {
  if (ts >= PEAK_PRICING_START_MS) {
    const band = isPeakHour(new Date(ts)) ? 'peak' : 'offPeak';
    if (pricingKey === 'pro') return PRO_PEAK[band];
    return (ts >= PEAK_PRICING_V2_START_MS ? FLASH_PEAK_V2 : FLASH_PEAK)[band];
  }
  return pricingKey === 'pro' ? PRO_COST : FLASH_COST;
}

/** 指定时刻所属计费档位：base（8-17 前）/ offPeak / peak。 */
function bandAt(ts) {
  return ts >= PEAK_PRICING_START_MS ? (isPeakHour(new Date(ts)) ? 'peak' : 'offPeak') : 'base';
}

export function apply(ctx) {
  const webServer = ctx.webServer;
  const sessions = ctx.get("sessions");
  const credentials = ctx.get("credentials");
  const projections = ctx.get("sessionProjections");
  const sessionQuery = ctx.get("sessionQuery");
  const tools = ctx.get("tools");

  const BALANCE_URL = "https://api.deepseek.com/user/balance";
  const BALANCE_TTL_MS = 30000;

  // —— 配置持久化（消耗上限）——
  const CONFIG_DIR = join(homedir(), ".dsh");
  const CONFIG_FILE = join(CONFIG_DIR, "dsh-wallet.json");

  const bootThresholds = Object.create(null); // 启动时从磁盘加载的值
  const costThresholds = Object.create(null); // 本进程内新设置的值（优先）
  let bootPlatformToken = ""; // 启动时从磁盘加载的官方平台 userToken

  async function loadConfig() {
    try {
      const text = (await readFile(CONFIG_FILE, "utf8")).replace(/^\uFEFF/, ""); // 容忍 UTF-8 BOM
      const obj = JSON.parse(text);
      const src = obj && obj.costThresholds;
      if (src && typeof src === "object") {
        for (const [sid, t] of Object.entries(src)) {
          const n = Number(t);
          if (sid && Number.isFinite(n) && n >= 0) bootThresholds[sid] = n;
        }
      }
      if (typeof obj.platformToken === "string" && obj.platformToken) bootPlatformToken = obj.platformToken;
    } catch { /* 首次运行无配置文件或损坏，忽略 */ }
  }

  let saveChain = Promise.resolve();
  function saveConfig() {
    saveChain = saveChain.then(async () => {
      try {
        await mkdir(CONFIG_DIR, { recursive: true });
        const merged = Object.assign({}, bootThresholds, costThresholds);
        await writeFile(CONFIG_FILE, JSON.stringify({ costThresholds: merged, platformToken: bootPlatformToken }, null, 2), "utf8");
      } catch { /* 写失败不影响功能 */ }
    });
    return saveChain;
  }

  function getThreshold(sid) {
    if (costThresholds[sid] !== undefined) return costThresholds[sid];
    if (bootThresholds[sid] !== undefined) return bootThresholds[sid];
    return 5;
  }

  loadConfig(); // 异步加载，不阻塞启动

  // —— 余额缓存 + 失败指数退避重试 ——
  let key = "";
  let balanceView = null;
  let balanceAt = 0;
  let inflight = null;
  let failCount = 0;
  let nextRetryAt = 0;
  const BACKOFF_BASE_MS = 5000;
  const BACKOFF_MAX_MS = 300000; // 最长 5 分钟

  async function resolveKey() {
    if (!credentials) return "";
    try {
      const r = await credentials.resolve("DEEPSEEK_API_KEY");
      return r && r.value ? r.value : "";
    } catch {
      return "";
    }
  }

  async function queryBalance(force) {
    const now = Date.now();
    if (!force && balanceView && !balanceView.error && now - balanceAt < BALANCE_TTL_MS) return balanceView;
    // 退避窗口内：直接返回上次的失败结果，不再打网络
    if (!force && failCount > 0 && now < nextRetryAt && balanceView) return balanceView;
    if (inflight) return inflight;
    inflight = (async () => {
      if (!key) key = await resolveKey();
      const fetchedAt = Date.now();
      if (!key) return { fetchedAt, available: false, balances: [], error: "未配置 API Key（DEEPSEEK_API_KEY）" };
      try {
        const res = await fetch(BALANCE_URL, {
          method: "GET",
          headers: { Authorization: "Bearer " + key, Accept: "application/json" },
          signal: AbortSignal.timeout(15000),
        });
        const text = await res.text();
        if (!res.ok) {
          let msg = null;
          try { const obj = JSON.parse(text); msg = obj && obj.error && obj.error.message; } catch { /* ignore */ }
          failCount += 1;
          nextRetryAt = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, failCount - 1));
          return { fetchedAt, available: false, balances: [], error: msg || ("HTTP " + res.status), retryInMs: nextRetryAt - Date.now() };
        }
        const body = JSON.parse(text);
        const buckets = (Array.isArray(body.balance_infos) ? body.balance_infos : [])
          .map((b) => ({
            currency: String(b.currency || ""),
            total_balance: String(b.total_balance ?? "0"),
            granted_balance: String(b.granted_balance ?? "0"),
            topped_up_balance: String(b.topped_up_balance ?? "0"),
          }))
          .filter((b) => b.currency !== "");
        const total = buckets.length === 1 ? Number(buckets[0].total_balance) : undefined;
        // 低余额告警：CNY < 10 或 USD < 2 时标记
        const LOW_THRESHOLD = { CNY: 10, USD: 2 };
        const low = buckets
          .filter((b) => Number(b.total_balance) < (LOW_THRESHOLD[b.currency] ?? 10))
          .map((b) => ({ currency: b.currency, total: b.total_balance }));
        failCount = 0; // 成功则重置退避
        nextRetryAt = 0;
        return {
          fetchedAt,
          available: body.is_available !== false,
          balances: buckets,
          ...(total !== undefined && !Number.isNaN(total) ? { total, currency: buckets[0].currency } : {}),
          ...(low.length ? { low } : {}),
        };
      } catch (error) {
        const aborted = error && (error.name === "AbortError" || error.name === "TimeoutError");
        failCount += 1;
        nextRetryAt = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, failCount - 1));
        return {
          fetchedAt,
          available: false,
          balances: [],
          error: aborted ? "查询超时" : String(error && error.message || error).slice(0, 200),
          retryInMs: nextRetryAt - Date.now(),
        };
      }
    })().then((v) => { balanceView = v; balanceAt = Date.now(); return v; }).finally(() => { inflight = null; });
    return inflight;
  }

  // —— 会话成本 ——
  function sessionCost(session) {
    const id = session && session.id ? String(session.id) : "";
    const seg = perSession.get(id) || emptySessionAgg();
    let pricingKey = "flash";
    let model;
    try {
      const header = typeof session.requestHeader === "function" ? session.requestHeader() : undefined;
      model = header && header.config && header.config.model;
      pricingKey = pricingKeyOf(model);
    } catch { /* 读不到模型按 flash */ }
    // 分段计费：金额已在摄入事件时按「该事件发生时刻」生效的价格累计，此处只做汇总。
    // 不再用当前价格重算历史 token——跨 2026-09-10 12:00 flash 调价点的会话会被整体算错。
    const sum = (f) => seg.base[f] + seg.offPeak[f] + seg.peak[f];
    const breakdown = {
      input: sum("inputCost"),
      cacheRead: sum("cacheReadCost"),
      cacheWrite: sum("cacheWriteCost"),
      output: sum("outputCost"),
    };
    const peakActive = Date.now() >= PEAK_PRICING_START_MS;
    const band = peakActive ? (isPeakHour() ? "peak" : "offPeak") : "base";
    return {
      uncachedInputTokens: sum("uncachedInputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheWriteTokens: sum("cacheWriteTokens"),
      cost: breakdown.input + breakdown.cacheRead + breakdown.cacheWrite + breakdown.output,
      currency: "CNY",
      pricingKey,
      band,
      ...(model ? { model } : {}),
      breakdown,
    };
  }

  function resolveSession(id) {
    if (!sessions || typeof id !== "string") return undefined;
    try { return sessions.get(id); } catch { return undefined; }
  }

  // —— 今日消耗 / 历史趋势（事件流聚合）——
  const USAGE_KEEP_MS = 90 * 86400000;
  const perDay = new Map(); // dayKey -> { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, requests }
  const perSession = new Map(); // sessionId -> { base, offPeak, peak } 各计费档 token 桶（分段计费用）
  // —— 看板旁路聚合（只增不改：既有三条口径与 /wallet/api/usage 载荷保持原样）——
  const perDayBand = new Map(); // dayKey -> { peakCost, offPeakCost, peakTokens, offPeakTokens }
  const perDayHour = new Map(); // "dayKey|hour" -> { cost, tokens, requests }
  const perSessionDay = new Map(); // sessionId -> Map<dayKey, 完整日记录（emptySessionDay）>
  const perSessionHour = new Map(); // sessionId -> Map<"dayKey|hour", { cost, tokens, requests }>
  const sessionLastAt = new Map(); // sessionId -> 该会话最近一条计费事件的时间戳
  const scannedSessions = new Set(); // 已摄入过事件的会话 id
  const liveSessionIds = new Set(); // 活动区当前存在的会话 id（只用于存档缓存排除，不参与按需回扫判定）
  const liveSeqs = new Map(); // sessionId -> 已实时摄入的最大 seq
  let usageReady = false;

  // —— 存档扫描状态（活动区之外的历史只存在于 archive\dsh-sessions\*.zip）——
  // DSH_USAGE_ARCHIVE（; 分隔多个根）设置了就以它为准，否则用本机默认存档目录
  const ARCHIVE_DIRS = (process.env.DSH_USAGE_ARCHIVE
    ? String(process.env.DSH_USAGE_ARCHIVE).split(PATH_DELIMITER)
    : [join(homedir(), "DeepSeek_harness", "archive", "dsh-sessions")]
  ).filter((v) => typeof v === "string" && v.length > 0 && v.trim().length > 0);
  const ARCHIVE_CACHE_FILE = process.env.DSH_WALLET_ARCHIVE_CACHE || join(CONFIG_DIR, "dsh-wallet-archive.json");
  const ARCHIVE_CACHE_VERSION = 1;
  const archiveSeenZips = Object.create(null); // zip 绝对路径 -> "mtime:size" 指纹
  const archivedSessions = new Set(); // 由存档并入的会话 id（回写缓存用）
  const archiveStatus = { running: false, done: false, scanned: 0, pending: 0, merged: 0, sessions: 0, error: null, scannedAt: 0 };

  function dayKeyOf(time) {
    const d = new Date(time);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function emptyDayAgg() {
    return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, requests: 0 };
  }

  // 桶内同时累计 token 与「按事件发生时刻价格算出的金额」，避免事后按当前价格重算历史
  function emptyBuckets() {
    return {
      uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      inputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, outputCost: 0,
    };
  }

  function emptyDayBand() {
    return {
      peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0,
      inputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, outputCost: 0,
    };
  }

  function emptyHourAgg() {
    return { cost: 0, tokens: 0, requests: 0 };
  }

  // 会话×日记录：存档缓存按固定字段顺序序列化，见 encodeSessionDay / decodeSessionDay
  function emptySessionDay() {
    return {
      cost: 0, requests: 0,
      uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0,
      inputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, outputCost: 0,
    };
  }

  function emptySessionAgg() {
    // maxSeq：本会话已摄入的最大事件 seq，用于「实时摄入」与「启动全量回扫」交错时的去重
    return { base: emptyBuckets(), offPeak: emptyBuckets(), peak: emptyBuckets(), maxSeq: -1 };
  }

  function ingestEvent(sessionId, event) {
    if (!event || typeof event.time !== "number" || event.type !== "assistant/message") return;
    const data = event.data || {};
    const usage = data.usage;
    if (!usage || typeof usage !== "object") return;
    // seq 单调去重：启动回扫与实时事件可能交错覆盖同一条事件，避免同一事件被计费两次
    const prevAgg = perSession.get(sessionId);
    if (prevAgg && typeof event.seq === "number" && event.seq <= prevAgg.maxSeq) return;
    const input = Number(usage.inputTokens) || 0;
    // reasoning tokens 已包含在 outputTokens 内（2026-09-10 实测：推理块字符/token 比例正常，
    // 非推理部分若按 outputTokens 单独折算只有 0.04-0.17 字符/token，属荒谬值），
    // 因此只按 outputTokens 计一次，不再叠加 reasoning，否则输出费用会翻倍高估。
    const reasoning = Number(usage.reasoningTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    const cacheRead = Number(usage.cacheReadTokens) || 0;
    const cacheWrite = Number(usage.cacheWriteTokens) || 0;
    const model = data.message && data.message.source ? String(data.message.source.model || "") : "";
    const cfg = effectiveCostAt(event.time, pricingKeyOf(model));
    const inputCost = costOfTokens(input, cfg.inputPerMillion);
    const cacheReadCost = costOfTokens(cacheRead, cfg.cacheReadPerMillion);
    const cacheWriteCost = costOfTokens(cacheWrite, cfg.cacheWritePerMillion);
    const outputCost = costOfTokens(output, cfg.outputPerMillion);
    const cost = inputCost + cacheReadCost + cacheWriteCost + outputCost;
    const day = dayKeyOf(event.time);
    // 本事件所属计费档：日桶、会话桶、看板旁路桶共用这一次判定
    const band = bandAt(event.time);
    const tokens = input + output + cacheRead + cacheWrite;
    const agg = perDay.get(day) || emptyDayAgg();
    agg.uncachedInputTokens += input;
    agg.outputTokens += output;
    agg.cacheReadTokens += cacheRead;
    agg.cacheWriteTokens += cacheWrite;
    agg.cost += cost;
    agg.requests += 1;
    perDay.set(day, agg);
    // —— 看板旁路聚合 ——
    const dayBand = perDayBand.get(day) || emptyDayBand();
    if (band === "peak") { dayBand.peakCost += cost; dayBand.peakTokens += tokens; }
    else { dayBand.offPeakCost += cost; dayBand.offPeakTokens += tokens; }
    dayBand.inputCost += inputCost; dayBand.cacheReadCost += cacheReadCost;
    dayBand.cacheWriteCost += cacheWriteCost; dayBand.outputCost += outputCost;
    perDayBand.set(day, dayBand);
    const hourKey = day + "|" + new Date(event.time).getHours();
    const hourAgg = perDayHour.get(hourKey) || emptyHourAgg();
    hourAgg.cost += cost; hourAgg.tokens += tokens; hourAgg.requests += 1;
    perDayHour.set(hourKey, hourAgg);
    let sDays = perSessionDay.get(sessionId);
    if (!sDays) { sDays = new Map(); perSessionDay.set(sessionId, sDays); }
    const sDay = sDays.get(day) || emptySessionDay();
    sDay.cost += cost; sDay.requests += 1;
    sDay.uncachedInputTokens += input; sDay.outputTokens += output;
    sDay.cacheReadTokens += cacheRead; sDay.cacheWriteTokens += cacheWrite;
    if (band === "peak") { sDay.peakCost += cost; sDay.peakTokens += tokens; }
    else { sDay.offPeakCost += cost; sDay.offPeakTokens += tokens; }
    sDay.inputCost += inputCost; sDay.cacheReadCost += cacheReadCost;
    sDay.cacheWriteCost += cacheWriteCost; sDay.outputCost += outputCost;
    sDays.set(day, sDay);
    let sHours = perSessionHour.get(sessionId);
    if (!sHours) { sHours = new Map(); perSessionHour.set(sessionId, sHours); }
    const sHour = sHours.get(hourKey) || emptyHourAgg();
    sHour.cost += cost; sHour.tokens += tokens; sHour.requests += 1;
    sHours.set(hourKey, sHour);
    if (event.time > (sessionLastAt.get(sessionId) || 0)) sessionLastAt.set(sessionId, event.time);
    // 按计费档位分桶（供本会话分段计费；金额同样按该事件时刻的价格累计，跨调价点也不会重算错）
    const sagg = perSession.get(sessionId) || emptySessionAgg();
    const b = sagg[band];
    b.uncachedInputTokens += input;
    b.outputTokens += output;
    b.cacheReadTokens += cacheRead;
    b.cacheWriteTokens += cacheWrite;
    b.inputCost += inputCost;
    b.cacheReadCost += cacheReadCost;
    b.cacheWriteCost += cacheWriteCost;
    b.outputCost += outputCost;
    if (typeof event.seq === "number" && event.seq > sagg.maxSeq) sagg.maxSeq = event.seq;
    perSession.set(sessionId, sagg);
  }

  ctx.on("session/event", (session, event) => {
    if (!session || !event || typeof event.time !== "number") return;
    const id = String(session.id || "");
    if (!id) return;
    scannedSessions.add(id);
    const prev = liveSeqs.get(id) || 0;
    if (typeof event.seq === "number" && event.seq > prev) liveSeqs.set(id, event.seq);
    if (event.time >= Date.now() - USAGE_KEEP_MS) {
      // 分叉去重：子会话会继承父会话前 seedLength 条事件（副本），跳过避免重复计数
      const seedLength = Number((session && session.header && session.header.seedLength)) || 0;
      if (typeof event.seq === "number" && event.seq < seedLength) return;
      ingestEvent(id, event);
    }
  });

  async function scanHistory() {
    if (!sessionQuery) { usageReady = true; return; }
    try {
      const list = await sessionQuery.listSessions();
      const cut = Date.now() - USAGE_KEEP_MS;
      let scanned = 0;
      for (const record of list || []) {
        const header = record && record.header;
        const id = header && String(header.id || "");
        if (!id) continue;
        scannedSessions.add(id);
        try {
          const snap = await sessionQuery.readSession(id);
          const events = Array.isArray(snap && snap.events) ? snap.events : [];
          // 分叉子会话从父会话继承了前 seedLength 条事件（副本），跳过避免重复计数
          const seedLength = Number(header.seedLength) || 0;
          const liveMax = liveSeqs.get(id); // 已实时摄入的最大 seq（无则 undefined）
          for (const event of events) {
            if (!event || typeof event.time !== "number" || event.time < cut) continue;
            if (typeof event.seq === "number") {
              if (event.seq < seedLength) continue;
              if (liveMax !== undefined && event.seq <= liveMax) continue;
            }
            ingestEvent(id, event);
          }
          scanned += 1;
        } catch { scannedSessions.delete(id); /* 读取失败则允许下次重试，否则该会话永久漏计 */ }
        // 全量回扫：不设上限，避免历史会话（>100 个）事件永久漏计（08-19 曾整体缺失）
        if (scanned >= 4000) break;
      }
    } catch { /* 扫描失败忽略 */ }
    usageReady = true;
  }
  // 全量回扫照旧在后台跑；存档链只等「活动区会话 id 清单」——那份清单解析很快，
  // 而全量回扫在 226 个会话上要几分钟，等它才装载缓存会让看板好几分钟看不到存档数据。
  scanHistory();
  const liveIdsReady = (async () => {
    if (!sessionQuery) return;
    try {
      const list = await sessionQuery.listSessions();
      for (const record of list || []) {
        const id = record && record.header && String(record.header.id || "");
        if (id) liveSessionIds.add(id);
      }
    } catch { /* 取不到清单时按「没有活动区会话」处理，极端情况下宁可多算也不漏算 */ }
  })();
  liveIdsReady
    .then(() => loadArchiveCache())
    .then(() => scanArchive())
    .catch(() => { /* 存档不可读时保持活动区口径 */ });

  // 会话成本按需回扫：切换到未扫过（>100 个）的旧会话时，补读其事件做分段计费
  async function ensureSessionIngested(session) {
    if (!sessionQuery) return;
    const id = session && session.id ? String(session.id) : "";
    if (!id || scannedSessions.has(id)) return;
    scannedSessions.add(id);
    try {
      const snap = await sessionQuery.readSession(id);
      const events = Array.isArray(snap && snap.events) ? snap.events : [];
      const seedLength = Number((session && session.header && session.header.seedLength)) || 0;
      const liveMax = liveSeqs.get(id);
      const cut = Date.now() - USAGE_KEEP_MS;
      for (const event of events) {
        if (!event || typeof event.time !== "number" || event.time < cut) continue;
        if (typeof event.seq === "number") {
          if (event.seq < seedLength) continue;
          if (liveMax !== undefined && event.seq <= liveMax) continue;
        }
        ingestEvent(id, event);
      }
    } catch { scannedSessions.delete(id); /* 读取失败则允许下次重试，否则该会话永久漏计 */ }
  }

  // —— 存档扫描：把活动区之外的历史用同一套计价函数补进聚合（只读，不动活动区与会话列表）——
  /** 会话×日记录的序列化顺序：[cost, requests, in, out, cr, cw, peakCost, offPeakCost, peakTokens, offPeakTokens, inputCost, cacheReadCost, cacheWriteCost, outputCost] */
  const SESSION_DAY_KEYS = [
    "cost", "requests", "uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
    "peakCost", "offPeakCost", "peakTokens", "offPeakTokens",
    "inputCost", "cacheReadCost", "cacheWriteCost", "outputCost",
  ];

  function encodeSessionDay(rec) {
    return SESSION_DAY_KEYS.map((k) => rec[k] || 0);
  }

  function decodeSessionDay(arr) {
    const rec = emptySessionDay();
    for (let i = 0; i < SESSION_DAY_KEYS.length; i += 1) rec[SESSION_DAY_KEYS[i]] = Number(arr[i]) || 0;
    return rec;
  }

  /** 把一个会话的一天并进各聚合（缓存装载用；存档实扫走 ingestEvent，不重复并）。 */
  function mergeSessionDay(sessionId, day, rec, lastAt) {
    const dayAgg = perDay.get(day) || emptyDayAgg();
    dayAgg.uncachedInputTokens += rec.uncachedInputTokens;
    dayAgg.outputTokens += rec.outputTokens;
    dayAgg.cacheReadTokens += rec.cacheReadTokens;
    dayAgg.cacheWriteTokens += rec.cacheWriteTokens;
    dayAgg.cost += rec.cost;
    dayAgg.requests += rec.requests;
    perDay.set(day, dayAgg);
    const dayBand = perDayBand.get(day) || emptyDayBand();
    dayBand.peakCost += rec.peakCost; dayBand.offPeakCost += rec.offPeakCost;
    dayBand.peakTokens += rec.peakTokens; dayBand.offPeakTokens += rec.offPeakTokens;
    dayBand.inputCost += rec.inputCost; dayBand.cacheReadCost += rec.cacheReadCost;
    dayBand.cacheWriteCost += rec.cacheWriteCost; dayBand.outputCost += rec.outputCost;
    perDayBand.set(day, dayBand);
    let sDays = perSessionDay.get(sessionId);
    if (!sDays) { sDays = new Map(); perSessionDay.set(sessionId, sDays); }
    sDays.set(day, rec);
    if (lastAt > (sessionLastAt.get(sessionId) || 0)) sessionLastAt.set(sessionId, lastAt);
  }

  function mergeSessionHour(sessionId, hourKey, agg) {
    const hourAgg = perDayHour.get(hourKey) || emptyHourAgg();
    hourAgg.cost += agg.cost; hourAgg.tokens += agg.tokens; hourAgg.requests += agg.requests;
    perDayHour.set(hourKey, hourAgg);
    let sHours = perSessionHour.get(sessionId);
    if (!sHours) { sHours = new Map(); perSessionHour.set(sessionId, sHours); }
    sHours.set(hourKey, agg);
  }

  async function loadArchiveCache() {
    try {
      const text = (await readFile(ARCHIVE_CACHE_FILE, "utf8")).replace(/^\uFEFF/, "");
      const obj = JSON.parse(text);
      if (!obj || obj.version !== ARCHIVE_CACHE_VERSION) return;
      if (obj.zips && typeof obj.zips === "object") {
        for (const [zipPath, fp] of Object.entries(obj.zips)) if (typeof fp === "string") archiveSeenZips[zipPath] = fp;
      }
      const sessions = obj.sessions && typeof obj.sessions === "object" ? obj.sessions : {};
      for (const [sessionId, rec] of Object.entries(sessions)) {
        // 会话若已回到活动区（从存档恢复过），一律以活动区事件为准，跳过缓存避免重复计数
        if (scannedSessions.has(sessionId)) continue;
        const lastAt = Number(rec && rec.lastAt) || 0;
        const days = rec && rec.days && typeof rec.days === "object" ? rec.days : {};
        for (const [day, arr] of Object.entries(days)) {
          if (Array.isArray(arr)) mergeSessionDay(sessionId, day, decodeSessionDay(arr), lastAt);
        }
        const hours = rec && rec.hours && typeof rec.hours === "object" ? rec.hours : {};
        for (const [hourKey, arr] of Object.entries(hours)) {
          if (!Array.isArray(arr)) continue;
          mergeSessionHour(sessionId, hourKey, { cost: Number(arr[0]) || 0, tokens: Number(arr[1]) || 0, requests: Number(arr[2]) || 0 });
        }
        archivedSessions.add(sessionId);
        archiveStatus.merged += 1;
      }
      archiveStatus.scannedAt = Number(obj.scannedAt) || 0;
    } catch { /* 首次运行无缓存或缓存损坏，忽略 */ }
  }

  let archiveSaveChain = Promise.resolve();
  function saveArchiveCache() {
    archiveSaveChain = archiveSaveChain.then(async () => {
      try {
        const sessions = {};
        for (const sessionId of archivedSessions) {
          const days = perSessionDay.get(sessionId);
          if (!days) continue;
          const out = {};
          for (const [day, rec] of days) out[day] = encodeSessionDay(rec);
          const hours = {};
          const sHours = perSessionHour.get(sessionId);
          if (sHours) for (const [hourKey, agg] of sHours) hours[hourKey] = [agg.cost, agg.tokens, agg.requests];
          sessions[sessionId] = { days: out, hours, lastAt: sessionLastAt.get(sessionId) || 0 };
        }
        await mkdir(CONFIG_DIR, { recursive: true });
        await writeFile(ARCHIVE_CACHE_FILE, JSON.stringify({
          version: ARCHIVE_CACHE_VERSION, scannedAt: Date.now(), zips: archiveSeenZips, sessions,
        }), "utf8");
      } catch { /* 写失败不影响功能 */ }
    });
    return archiveSaveChain;
  }

  function sessionIdFromZip(zipPath) {
    const base = String(zipPath).split(/[\\/]/).pop() || "";
    return base.replace(/\.zip$/i, "");
  }

  /** 后台扫存档：先只读元信息筛掉窗口外与未变化的 zip，再解压正文逐事件计价。 */
  async function scanArchive() {
    if (archiveStatus.running) return;
    archiveStatus.running = true;
    archiveStatus.done = false;
    const cut = Date.now() - USAGE_KEEP_MS;
    try {
      const zips = [];
      for (const root of ARCHIVE_DIRS) {
        const found = await listArchiveZips(root);
        for (const zipPath of found) zips.push(zipPath);
      }
      const todo = [];
      for (const zipPath of zips) {
        let st = null;
        try { st = await stat(zipPath); } catch { continue; }
        const fp = Math.round(st.mtimeMs) + ":" + st.size;
        if (archiveSeenZips[zipPath] === fp) continue; // 已并入过（增量：日常只处理新归档）
        const info = await readArchiveEntryInfo(zipPath);
        if (!info || info.mtime < cut) { archiveSeenZips[zipPath] = fp; continue; } // 窗口外：只记指纹不解压
        todo.push({ zipPath, fp });
      }
      archiveStatus.pending = todo.length;
      let since = 0;
      for (const item of todo) {
        const one = await readArchiveSession(item.zipPath);
        archiveSeenZips[item.zipPath] = item.fp;
        archiveStatus.scanned += 1;
        if (one && one.text) {
          let sessionId = "";
          let used = false;
          eachArchiveEvent(one.text, (ev) => {
            if (!ev || typeof ev.time !== "number") return;
            if (ev.type === "session" && typeof ev.id === "string" && sessionId === "") { sessionId = ev.id; return; }
            if (ev.type !== "assistant/message" || ev.time < cut) return;
            ingestEvent(sessionId || sessionIdFromZip(item.zipPath), ev);
            used = true;
          });
          if (used) {
            archivedSessions.add(sessionId || sessionIdFromZip(item.zipPath));
            archiveStatus.sessions += 1;
            archiveStatus.bytes += one.text.length;
          }
        }
        since += 1;
        await new Promise((resolve) => setImmediate(resolve)); // 每个文件让出一次，界面不卡
        if (since >= 64) { since = 0; await saveArchiveCache(); }
      }
      await saveArchiveCache();
      archiveStatus.scannedAt = Date.now();
    } catch (e) {
      archiveStatus.error = String((e && e.message) || e).slice(0, 200);
    } finally {
      archiveStatus.running = false;
      archiveStatus.done = true;
    }
  }

  function usagePayload() {
    const days = [...perDay.entries()]
      .map(([date, agg]) => ({ date, ...agg }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const todayKey = dayKeyOf(Date.now());
    const today = days.length && days[days.length - 1].date === todayKey ? days[days.length - 1] : { date: todayKey, ...emptyDayAgg() };
    const round = (d) => {
      const o = {};
      for (const [k, v] of Object.entries(d)) o[k] = (k === "cost" || k === "total") && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v;
      return o;
    };
    return { ok: true, ready: usageReady, source: "local", today: round(today), days: days.slice(-7).map(round) };
  }

  // —— 看板聚合：近 N 天的 日 / 时段 / 会话 三个维度（只读，供 /wallet/api/board）——
  const BOARD_MAX_DAYS = 90;

  /** 最近 days 天的北京日期串，从最早到今天，缺数据的日子也占位（看板按固定格数渲染）。 */
  function dayKeysBack(days) {
    const out = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i -= 1) out.push(dayKeyOf(base.getTime() - i * 86400000));
    return out;
  }

  /** 周一为 0 的星期序号（时段热力图按 周一..周日 七行渲染）。 */
  function weekdayMon0(dayKey) {
    const parts = dayKey.split("-").map(Number);
    const wd = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
    return (wd + 6) % 7;
  }

  function boardPayload(days) {
    const n = Math.max(1, Math.min(BOARD_MAX_DAYS, Math.floor(days) || 30));
    const keys = dayKeysBack(n);
    const inWindow = new Set(keys);
    const r4 = (v) => Math.round(v * 10000) / 10000;

    const dayRow = (key) => {
      const agg = perDay.get(key) || emptyDayAgg();
      const band = perDayBand.get(key) || emptyDayBand();
      return {
        date: key,
        cost: r4(agg.cost),
        requests: agg.requests,
        uncachedInputTokens: agg.uncachedInputTokens,
        outputTokens: agg.outputTokens,
        cacheReadTokens: agg.cacheReadTokens,
        cacheWriteTokens: agg.cacheWriteTokens,
        peakCost: r4(band.peakCost),
        offPeakCost: r4(band.offPeakCost),
        peakTokens: band.peakTokens,
        offPeakTokens: band.offPeakTokens,
        inputCost: r4(band.inputCost),
        cacheReadCost: r4(band.cacheReadCost),
        cacheWriteCost: r4(band.cacheWriteCost),
        outputCost: r4(band.outputCost),
      };
    };
    const dayRows = keys.map(dayRow);

    const totalsOf = (count) => {
      const t = {
        cost: 0, requests: 0,
        uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0,
        inputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, outputCost: 0,
      };
      // 合计口径与图表窗口无关：近 7 天 / 近 30 天 / 近 90 天各自固定，不随 days 参数伸缩
      for (const key of dayKeysBack(Math.min(count, BOARD_MAX_DAYS))) {
        const agg = perDay.get(key) || emptyDayAgg();
        const band = perDayBand.get(key) || emptyDayBand();
        t.cost += agg.cost; t.requests += agg.requests;
        t.uncachedInputTokens += agg.uncachedInputTokens; t.outputTokens += agg.outputTokens;
        t.cacheReadTokens += agg.cacheReadTokens; t.cacheWriteTokens += agg.cacheWriteTokens;
        t.peakCost += band.peakCost; t.offPeakCost += band.offPeakCost;
        t.peakTokens += band.peakTokens; t.offPeakTokens += band.offPeakTokens;
        t.inputCost += band.inputCost; t.cacheReadCost += band.cacheReadCost;
        t.cacheWriteCost += band.cacheWriteCost; t.outputCost += band.outputCost;
      }
      t.cost = r4(t.cost); t.peakCost = r4(t.peakCost); t.offPeakCost = r4(t.offPeakCost);
      t.inputCost = r4(t.inputCost); t.cacheReadCost = r4(t.cacheReadCost);
      t.cacheWriteCost = r4(t.cacheWriteCost); t.outputCost = r4(t.outputCost);
      return t;
    };

    // 时段：窗口内逐日逐小时 → 周内七行 × 24 列，slot = 周一为 0 的星期 * 24 + 小时
    const hourCost = new Array(168).fill(0);
    const hourTokens = new Array(168).fill(0);
    const hourReq = new Array(168).fill(0);
    for (const [key, agg] of perDayHour) {
      const at = key.indexOf("|");
      const date = key.slice(0, at);
      if (!inWindow.has(date)) continue;
      const hour = Number(key.slice(at + 1));
      if (!(hour >= 0 && hour <= 23)) continue;
      const idx = weekdayMon0(date) * 24 + hour;
      hourCost[idx] += agg.cost; hourTokens[idx] += agg.tokens; hourReq[idx] += agg.requests;
    }
    const hours = [];
    for (let i = 0; i < 168; i += 1) {
      hours.push({ slot: i, cost: r4(hourCost[i]), tokens: hourTokens[i], requests: hourReq[i] });
    }

    // 会话榜：窗口内按会话聚合（只统计窗口内有计费事件的会话）
    const sessionRows = [];
    for (const [sid, byDay] of perSessionDay) {
      let cost = 0, tokens = 0, requests = 0, dayCount = 0;
      for (const [key, agg] of byDay) {
        if (!inWindow.has(key)) continue;
        cost += agg.cost; tokens += agg.tokens; requests += agg.requests; dayCount += 1;
      }
      if (requests > 0) sessionRows.push({ id: sid, cost: r4(cost), tokens, requests, days: dayCount, lastAt: sessionLastAt.get(sid) || 0 });
    }
    sessionRows.sort((a, b) => b.cost - a.cost);

    const todayKey = dayKeyOf(Date.now());
    return {
      ok: true,
      ready: usageReady,
      source: "local",
      generatedAt: Date.now(),
      windowDays: n,
      today: dayRow(todayKey),
      totals: { today: totalsOf(1), d7: totalsOf(7), d30: totalsOf(30), d90: totalsOf(90) },
      days: dayRows,
      hours,
      sessions: sessionRows.slice(0, 12),
      sessionCount: sessionRows.length,
      // 存档补齐进度（前端只在 running 时提示）
      archive: {
        running: archiveStatus.running,
        done: archiveStatus.done,
        scanned: archiveStatus.scanned,
        pending: archiveStatus.pending,
        sessions: archiveStatus.sessions,
        merged: archiveStatus.merged,
        error: archiveStatus.error,
        scannedAt: archiveStatus.scannedAt,
      },
    };
  }

  // —— 官方用量（platform userToken，可选；未配置/失败则回退本地聚合）——
  const PLATFORM_BASE = "https://platform.deepseek.com/api/v0/usage";
  let platformToken = "";
  let officialCache = null;
  let officialAt = 0;
  const OFFICIAL_TTL_MS = 300000; // 5 分钟

  // userToken 在 localStorage 里是 {"value":"...","__version":"0"}，取 .value；也兼容直接存裸 token
  function extractToken(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (s.startsWith("{")) {
      try { const o = JSON.parse(s); if (o && typeof o.value === "string" && o.value) return o.value; } catch { /* 非 JSON，按原样 */ }
    }
    return s;
  }

  async function resolvePlatformToken() {
    if (credentials) {
      try {
        const r = await credentials.resolve("DEEPSEEK_PLATFORM_TOKEN");
        const v = extractToken(r && r.value);
        if (v) return v;
      } catch { /* 忽略 */ }
    }
    return extractToken(bootPlatformToken);
  }

  // 官方用量接口是平台私有端点（需登录后的 userToken，非 API Key），逐月拉取近 30 天成本
  async function fetchOfficialDays() {
    if (!platformToken) platformToken = await resolvePlatformToken();
    if (!platformToken) return null;
    const headers = {
      Authorization: "Bearer " + platformToken,
      "x-app-version": "1.0.0",
      Accept: "application/json",
      Referer: "https://platform.deepseek.com/usage",
      Origin: "https://platform.deepseek.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    };
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const months = [
      { m: prev.getMonth() + 1, y: prev.getFullYear() },
      { m: now.getMonth() + 1, y: now.getFullYear() },
    ];
    const costByDate = new Map();
    for (const { m, y } of months) {
      try {
        const res = await fetch(`${PLATFORM_BASE}/cost?month=${m}&year=${y}`, { headers, signal: AbortSignal.timeout(10000) });
        if (!res.ok) return null;
        const json = await res.json();
        if (!json || json.code !== 0) return null; // 平台始终返回 200，失败体现在 code
        const biz = Array.isArray(json && json.data && json.data.biz_data) ? json.data.biz_data[0] : (json && json.data && json.data.biz_data);
        const todayStr = dayKeyOf(Date.now());
        for (const day of (biz && biz.days) || []) {
          if (typeof day.date === "string" && day.date > todayStr) continue; // 过滤未来日期（平台返回整月）
          const cost = (day.data || []).reduce((s, mu) => s + (mu.usage || []).reduce((ss, e) => ss + (parseFloat(e.amount) || 0), 0), 0);
          costByDate.set(day.date, (costByDate.get(day.date) || 0) + cost);
        }
      } catch { return null; }
    }
    const days = [...costByDate.entries()]
      .map(([date, cost]) => ({ date, cost: Math.round(cost * 10000) / 10000 }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return days.length ? days.slice(-7) : null;
  }

  async function getOfficialDays() {
    const now = Date.now();
    if (officialCache && now - officialAt < OFFICIAL_TTL_MS) return officialCache;
    const v = await fetchOfficialDays();
    if (v && v.length) { officialCache = v; officialAt = now; return v; }
    return officialCache; // 失败回退上次成功缓存（首次失败则为 null）
  }

  // 官方「今日」成本：走时区感知接口 /usage/by_api_key/cost（官网用量页同款），
  // 按服务器本地时区切「今天」。旧 /usage/cost 的 date 字段按 UTC 切天，会与官网数字偏差。
  async function fetchOfficialToday() {
    if (!platformToken) platformToken = await resolvePlatformToken();
    if (!platformToken) return null;
    const headers = {
      Authorization: "Bearer " + platformToken,
      "x-app-version": "1.0.0",
      Accept: "application/json",
      Referer: "https://platform.deepseek.com/usage",
      Origin: "https://platform.deepseek.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    };
    // 服务器本地时区偏移（秒），北京 = +28800；与官网默认「device」时区一致
    const tz = -new Date().getTimezoneOffset() * 60;
    const now = new Date();
    const shifted = new Date(now.getTime() + tz * 1000);
    const y = shifted.getUTCFullYear();
    const m = shifted.getUTCMonth();
    const d = shifted.getUTCDate();
    const startSec = Math.floor(Date.UTC(y, m, d) / 1000) - tz;
    const endSec = startSec + 86400;
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = y + "-" + pad(m + 1) + "-" + pad(d);
    try {
      const res = await fetch(`${PLATFORM_BASE}/by_api_key/cost?start=${startSec}&end=${endSec}&tz=${tz}`, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const json = await res.json();
      if (!json || json.code !== 0) return null;
      const biz = json.data && json.data.biz_data;
      let cost = 0;
      for (const entry of (biz && biz.data) || []) {
        for (const series of (entry.series || [])) {
          for (const b of (series.buckets || [])) cost += parseFloat(b.cost) || 0;
        }
      }
      return { date: dateStr, cost: Math.round(cost * 10000) / 10000 };
    } catch {
      return null;
    }
  }

  let officialTodayCache = null;
  let officialTodayAt = 0;
  async function getOfficialToday() {
    const now = Date.now();
    if (officialTodayCache && now - officialTodayAt < OFFICIAL_TTL_MS) return officialTodayCache;
    const v = await fetchOfficialToday();
    if (v) { officialTodayCache = v; officialTodayAt = now; return v; }
    return officialTodayCache; // 失败回退上次成功缓存
  }

  // —— 路由 ——
  function registerRoute(method, path, handler) {
    if (!webServer) return;
    webServer.register({
      kind: "exact",
      path,
      handler: async (req, res) => {
        let result;
        try {
          if (req.method !== method) result = { ok: false, error: "method-not-allowed" };
          else result = await handler(req);
        } catch (e) {
          result = { ok: false, error: String(e && e.message || e).slice(0, 300) };
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      },
    });
  }

  registerRoute("GET", "/wallet/api/balance", async () => queryBalance(false));
  registerRoute("GET", "/wallet/api/refresh", async () => queryBalance(true));
  registerRoute("GET", "/wallet/api/cost", async (req) => {
    const url = new URL(req.url || "/", "http://x");
    const sid = url.searchParams.get("session");
    if (!sid) return { ok: false, error: "missing-session" };
    const session = resolveSession(sid);
    if (!session) return { ok: false, error: "unknown-session" };
    await ensureSessionIngested(session);
    return { ok: true, costThreshold: getThreshold(sid), ...sessionCost(session) };
  });
  registerRoute("GET", "/wallet/api/usage", async () => {
    // 今日累计以本地实时聚合为准（与「本会话消耗」同源，二者必然自洽：
    // 今日累计 ≥ 本会话今日部分，不会出现「本会话 > 今日累计」的假矛盾）。
    // 官方账单接口按小时桶结算，最近约 10~20 分钟未入账，仅作后台校准参考返回。
    const local = usagePayload();
    const official = await getOfficialDays();
    const officialToday = await getOfficialToday();
    const todayKey = dayKeyOf(Date.now());
    // 本地有今日数据时直接用本地；本地为空（今日零消耗）时用官方兜底展示
    const today = local.today && Number.isFinite(local.today.cost) && local.today.cost > 0
      ? local.today
      : (officialToday || { date: todayKey, cost: 0 });
    return {
      ok: true,
      ready: local.ready,
      source: "local",
      today,
      days: local.days,
      // 官方参考（前端可作明细核对/校准提示）
      official: official || [],
      officialToday,
      officialTodayStale: !!(officialToday && local.today && Math.abs(local.today.cost - officialToday.cost) > 0.01),
    };
  });
  registerRoute("GET", "/wallet/api/board", async (req) => {
    const url = new URL(req.url || "/", "http://x");
    const n = Number(url.searchParams.get("days"));
    return boardPayload(Number.isFinite(n) && n > 0 ? n : 30);
  });
  registerRoute("POST", "/wallet/api/set-threshold", async (req) => {
    let body = "";
    try { for await (const chunk of req) body += chunk; } catch { /* ignore */ }
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
    const sid = typeof parsed.session === "string" ? parsed.session : "";
    const t = Number(parsed.threshold);
    if (sid && Number.isFinite(t) && t >= 0) {
      costThresholds[sid] = t;
      saveConfig();
    }
    return { ok: true, costThreshold: sid ? getThreshold(sid) : 5 };
  });

  // —— 峰谷价自动抓取（可选，尽力而为；失败静默回退硬编码官方价）——
  const PRICING_PAGE_URL = "https://api-docs.deepseek.com/quick_start/pricing/";
  let pricingFetched = false;

  // 极简容错解析：仅当能同时、无歧义地提取出 flash 与 pro 的「输入/缓存命中/输出」单价，
  // 且数值落在合理区间（0 < x < 100 元/百万 token）时才返回；否则返回 null 用硬编码兜底。
  function parsePricing(html) {
    try {
      const text = String(html || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/g, " ")
        .replace(/\s+/g, " ");
      const num = (s) => { const m = s.match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : NaN; };
      const valid = (v) => Number.isFinite(v) && v > 0 && v < 100;
      const extract = (marker) => {
        const idx = text.toLowerCase().indexOf(marker);
        if (idx < 0) return null;
        const tail = text.slice(idx, idx + 260);
        const nums = (tail.match(/\d+(?:\.\d+)?/g) || []).map(Number);
        return nums.length >= 3 ? nums.slice(0, 3) : null;
      };
      const flash = extract("flash");
      const pro = extract("pro");
      if (!flash || !pro || !flash.every(valid) || !pro.every(valid)) return null;
      return {
        flash: { inputPerMillion: flash[0], cacheReadPerMillion: flash[1], outputPerMillion: flash[2] },
        pro: { inputPerMillion: pro[0], cacheReadPerMillion: pro[1], outputPerMillion: pro[2] },
      };
    } catch {
      return null;
    }
  }

  async function tryRefreshPricing() {
    if (pricingFetched) return;
    pricingFetched = true;
    try {
      const res = await fetch(PRICING_PAGE_URL, { signal: AbortSignal.timeout(8000), headers: { Accept: "text/html" } });
      if (!res.ok) return;
      const parsed = parsePricing(await res.text());
      if (!parsed) return;
      const applyBase = (t, p) => { t.inputPerMillion = p.inputPerMillion; t.cacheReadPerMillion = p.cacheReadPerMillion; t.outputPerMillion = p.outputPerMillion; };
      applyBase(FLASH_COST, parsed.flash);
      applyBase(PRO_COST, parsed.pro);
      // 峰谷价无公开解析标准，保留硬编码（基础价按抓取覆盖）
    } catch { /* 网络/解析失败 → 保持硬编码 */ }
  }
  tryRefreshPricing();

  // —— 模型工具 ——
  if (tools) {
    const renderText = (_args, value) => [{ type: "text", text: String(value && value.content || "") }];
    tools.register(defineTool({
      name: "query_deepseek_balance",
      description: "查询已配置的 DeepSeek API 账户余额（CNY/USD 双余额池），返回总余额与低余额提醒，并提示官方充值入口。",
      parameters: {},
      output: { schema: { type: "object", additionalProperties: true }, render: renderText },
      async execute() {
        const view = await queryBalance(false);
        if (view.error) return { content: "查询失败：" + view.error };
        if (!view.balances.length) return { content: "暂无余额数据" };
        const lines = ["## DeepSeek 余额"];
        for (const b of view.balances) {
          lines.push("- " + b.currency + " 总余额：" + b.total_balance + "（赠金 " + b.granted_balance + " / 充值 " + b.topped_up_balance + "）");
        }
        lines.push("- 建议前往官方平台充值：https://platform.deepseek.com/top_up");
        return { content: lines.join("\n") };
      },
    }));
  }
}
