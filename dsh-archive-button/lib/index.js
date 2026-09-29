// dsh-archive-button —— Host half
// Serves the sidebar button's routes and the settings page's archive listing:
//   GET  /dsh-archive/status -> { running, lastExit, result, scan }
//   POST /dsh-archive/scan   -> dry-run scan (archive-dsh-sessions.ps1 -DryRun), returns the pending summary
//   POST /dsh-archive/run    -> start the real archive in the background (-Force), returns immediately
//   GET  /dsh-archive/list   -> archived sessions on disk (zip entries) + last run/scan summaries
//   POST /dsh-archive/restore-> restore one archived zip back into the live sessions tree
// Every PowerShell child runs hidden with stdio ignored; results are exchanged
// through the JSON files the script writes. Never triggered by the model.

import { spawn } from "node:child_process";
import { readFileSync, appendFileSync, existsSync, renameSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export const name = "dsh-archive-button";
export const inject = ["webServer"];

const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const ROOT = process.env.DSH_ROOT || join(homedir(), "DeepSeek_harness");
const SCRIPT = join(ROOT, "scripts", "archive-dsh-sessions.ps1");
const _pkgScript = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "scripts", "archive-dsh-sessions.ps1");
const ACTIVE_SCRIPT = existsSync(_pkgScript) ? _pkgScript : SCRIPT;
const ARCHIVE_DIR = join(ROOT, "archive", "dsh-sessions");
const RESULT_FILE = ARCHIVE_DIR + "\\.last-result.json";
const SCAN_FILE = ARCHIVE_DIR + "\\.scan-result.json";
const LOG = join(ROOT, "logs", "dsh-archive-button.log");
const RESTORE_SCRIPT = join(ROOT, "scripts", "restore-dsh-session.ps1");
const SESSIONS_ROOT = join(homedir(), ".dsh", "sessions");

let running = false;
let lastExit = null;
let startedAt = null;

// 单文件日志上限（2026-09-11）：超过就整份改名为 `<日志>.1`，避免无限增长。
const LOG_MAX_BYTES = 1024 * 1024;

function log(msg) {
  try {
    if (statSync(LOG).size > LOG_MAX_BYTES) renameSync(LOG, LOG + ".1");
  } catch { /* 文件还不存在 / 正被占用：跳过轮转 */ }
  try { appendFileSync(LOG, new Date().toISOString() + " " + msg + "\n"); } catch { /* ignore */ }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function runScript(extraArgs, resultFile) {
  return runPowershell(["-File", ACTIVE_SCRIPT].concat(extraArgs).concat(["-ResultFile", resultFile]));
}

/** 跑一段 PowerShell 脚本文件；stdio 丢弃，退出码即结果。 */
function runPowershell(argsBefore) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => { if (!settled) { settled = true; resolve(code); } };
    try {
      const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"].concat(argsBefore);
      const child = spawn(PS, args, { stdio: "ignore", windowsHide: true });
      child.on("exit", (code) => finish(code === null || code === undefined ? -1 : code));
      child.on("error", (e) => { log("spawn error: " + (e && e.message)); finish(-1); });
    } catch (e) {
      log("spawn threw: " + (e && e.message));
      finish(-1);
    }
  });
}

/** 归档目录扫描：<ARCHIVE_DIR>\<workspace>\<yyyy-MM>\<sessionId>.zip */
function listArchived() {
  const out = [];
  let workspaces = [];
  try { workspaces = readdirSync(ARCHIVE_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const ws of workspaces) {
    const wsDir = join(ARCHIVE_DIR, ws);
    let months = [];
    try { months = readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const month of months) {
      const monthDir = join(wsDir, month);
      let files = [];
      try { files = readdirSync(monthDir).filter((n) => n.toLowerCase().endsWith(".zip")); } catch { continue; }
      for (const name of files) {
        const full = join(monthDir, name);
        let size = 0;
        let mtime = "";
        try { const st = statSync(full); size = st.size; mtime = st.mtime.toISOString(); } catch { /* ignore */ }
        out.push({ id: basename(name, ".zip"), name, workspace: ws, month, path: full, size, mtime });
      }
    }
  }
  out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return out;
}

/** 归档 zip 还原后的落点：<SessionsRoot>\<workspace>\<sessionId> */
function restoredDir(entry) {
  return join(SESSIONS_ROOT, entry.workspace, entry.id);
}

export function apply(ctx) {
  const webServer = ctx.get("webServer");
  if (!webServer) {
    log("webServer service unavailable, /dsh-archive/* not registered");
    return;
  }

  const send = (res, body) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  webServer.register({
    kind: "exact",
    path: "/dsh-archive/status",
    handler: async (req, res) => {
      send(res, {
        ok: true,
        running,
        lastExit,
        startedAt,
        result: readJson(RESULT_FILE),
        scan: readJson(SCAN_FILE),
      });
    },
  });

  webServer.register({
    kind: "exact",
    path: "/dsh-archive/scan",
    handler: async (req, res) => {
      if (req.method !== "POST") { send(res, { ok: false, error: "method-not-allowed" }); return; }
      if (running) { send(res, { ok: false, error: "archive-in-progress" }); return; }
      log("scan requested");
      const code = await runScript(["-DryRun"], SCAN_FILE);
      const data = readJson(SCAN_FILE);
      log("scan finished exit=" + code + " candidates=" + (data ? data.candidates : "?"));
      send(res, { ok: code === 0 && !!data, exitCode: code, scan: data });
    },
  });

  webServer.register({
    kind: "exact",
    path: "/dsh-archive/run",
    handler: async (req, res) => {
      if (req.method !== "POST") { send(res, { ok: false, error: "method-not-allowed" }); return; }
      if (running) { send(res, { ok: false, error: "archive-in-progress" }); return; }
      running = true;
      startedAt = new Date().toISOString();
      log("archive run started");
      runScript(["-Force"], RESULT_FILE).then((code) => {
        running = false;
        lastExit = code;
        log("archive run finished exit=" + code);
      });
      send(res, { ok: true, started: true, startedAt });
    },
  });

  webServer.register({
    kind: "exact",
    path: "/dsh-archive/list",
    handler: async (req, res) => {
      const entries = listArchived();
      send(res, {
        ok: true,
        entries: entries.map((e) => Object.assign({}, e, { restored: existsSync(restoredDir(e)) })),
        lastResult: readJson(RESULT_FILE),
        scan: readJson(SCAN_FILE),
        sessionsRoot: SESSIONS_ROOT,
      });
    },
  });

  webServer.register({
    kind: "exact",
    path: "/dsh-archive/restore",
    handler: async (req, res) => {
      if (req.method !== "POST") { send(res, { ok: false, error: "method-not-allowed" }); return; }
      let body = "";
      try { body = await new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); }); } catch { /* ignore */ }
      let payload = null;
      try { payload = JSON.parse(body || "{}"); } catch { /* ignore */ }
      const wanted = payload === null ? "" : String(payload.path || payload.id || "");
      if (wanted.length === 0) { send(res, { ok: false, error: "body needs { path } or { id }" }); return; }
      const entry = listArchived().find((e) => e.path === wanted || e.id === wanted || e.name === wanted);
      if (!entry) { send(res, { ok: false, error: "archive entry not found" }); return; }
      if (!existsSync(RESTORE_SCRIPT)) { send(res, { ok: false, error: "restore script missing: " + RESTORE_SCRIPT }); return; }
      log("restore requested: " + entry.path);
      const code = await runPowershell(["-File", RESTORE_SCRIPT, "-Zip", entry.path]);
      const dest = restoredDir(entry);
      const present = existsSync(dest);
      log("restore finished exit=" + code + " present=" + present);
      send(res, { ok: code === 0 && present, exitCode: code, restored: present, target: dest, id: entry.id });
    },
  });

  log("routes registered: /dsh-archive/status /dsh-archive/scan /dsh-archive/run /dsh-archive/list /dsh-archive/restore");
}
