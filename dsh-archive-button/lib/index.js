// dsh-archive-button —— Host half
// Serves the sidebar button's three routes:
//   GET  /dsh-archive/status -> { running, lastExit, result, scan }
//   POST /dsh-archive/scan   -> dry-run scan (archive-dsh-sessions.ps1 -DryRun), returns the pending summary
//   POST /dsh-archive/run    -> start the real archive in the background (-Force), returns immediately
// Every PowerShell child runs hidden with stdio ignored; results are exchanged
// through the JSON files the script writes. Never triggered by the model.

import { spawn } from "node:child_process";
import { readFileSync, appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => { if (!settled) { settled = true; resolve(code); } };
    try {
      const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ACTIVE_SCRIPT]
        .concat(extraArgs)
        .concat(["-ResultFile", resultFile]);
      const child = spawn(PS, args, { stdio: "ignore", windowsHide: true });
      child.on("exit", (code) => finish(code === null || code === undefined ? -1 : code));
      child.on("error", (e) => { log("spawn error: " + (e && e.message)); finish(-1); });
    } catch (e) {
      log("spawn threw: " + (e && e.message));
      finish(-1);
    }
  });
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

  log("routes registered: /dsh-archive/status /dsh-archive/scan /dsh-archive/run");
}
