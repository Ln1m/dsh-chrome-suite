// dsh-restart-button —— Host half
//
// Routes:
//   POST /dsh-restart/restart -> restart THIS process's own dsh instance
//   GET  /dsh-restart/status  -> identity of this instance (port / pid / argv)
//
// Why the identity matters (2026-09-11 fix): the plugin used to hardcode
// "kill the node on 3080 and relaunch `dsh web` from <DSH 安装根>".
// Two dsh instances share one Harness home here (3080 = main, 3098 = the
// second checkout), so pressing restart inside 3098 killed and relaunched
// 3080 instead: the wrong instance died and the clicked one never restarted.
// The handler now captures this process's own listen port, node executable,
// entry script, working directory and argv, writes them next to the log, and
// hands the port to a launcher that restarts exactly that instance.
//
// The browser POST is answered first; the actual kill happens ~0.8s later in a
// fully detached wscript -> powershell chain, so the page can observe the
// outage and reconnect. Never triggered by the model.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const name = "dsh-restart-button";
export const inject = ["webServer"];

const ROOT = process.env.DSH_ROOT || join(homedir(), "DeepSeek_harness");
const VBS = join(ROOT, "scripts", "dsh-restart-instance.vbs");
const LOG = join(ROOT, "logs", "dsh-restart-button.log");
const REQUEST_DIR = join(ROOT, "logs", "dsh-restart");
const DEFAULT_PORT = 3080;

// Cap the log at 1 MB (2026-09-11): rotate to <log>.1 before appending past it.
const LOG_MAX_BYTES = 1024 * 1024;

function log(msg) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    try {
      if (statSync(LOG).size > LOG_MAX_BYTES) renameSync(LOG, LOG + ".1");
    } catch {
      /* not created yet / busy: skip rotation */
    }
    appendFileSync(LOG, new Date().toISOString() + " " + msg + "\n");
  } catch {
    /* logging must never break the route */
  }
}

/** `--port N` / `--port=N` from one argv array; undefined when absent/invalid. */
function portFromArgv(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const inline = /^--port=(.*)$/u.exec(arg);
    const raw = inline !== null ? inline[1] : arg === "--port" ? argv[i + 1] : undefined;
    if (raw === undefined || raw === "") continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) return parsed;
  }
  return undefined;
}

export function apply(ctx) {
  const webServer = ctx.get("webServer");
  if (!webServer) {
    log("webServer service unavailable, /dsh-restart/* not registered");
    return;
  }

  const listenPort = typeof webServer.port === "number"
    ? webServer.port
    : (portFromArgv(process.argv) ?? DEFAULT_PORT);

  const entry = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
  const launch = {
    port: listenPort,
    pid: process.pid,
    nodeExe: process.execPath,
    entry,
    workDir: process.cwd(),
    args: process.argv.slice(2),
    dshHome: process.env.DSH_HOME ?? null,
    profile: process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : null,
  };
  const startedAt = new Date().toISOString();
  const requestFile = join(REQUEST_DIR, "request-" + String(listenPort) + ".json");

  const send = (res, body, status = 200) => {
    try {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    } catch {
      /* the client may already be gone */
    }
  };

  webServer.register({
    kind: "exact",
    path: "/dsh-restart/status",
    handler: async (req, res) => {
      send(res, {
        ok: true,
        port: listenPort,
        pid: process.pid,
        startedAt,
        launch: { entry: launch.entry, workDir: launch.workDir, args: launch.args, dshHome: launch.dshHome },
      });
    },
  });

  webServer.register({
    kind: "exact",
    path: "/dsh-restart/restart",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        send(res, { ok: false, error: "method-not-allowed" }, 200);
        return;
      }
      let requestWritten = false;
      try {
        mkdirSync(REQUEST_DIR, { recursive: true });
        writeFileSync(requestFile, JSON.stringify({ ...launch, requestedAt: new Date().toISOString() }, null, 2), "utf8");
        requestWritten = true;
      } catch (error) {
        log("request file write failed: " + (error && error.message));
      }
      log("POST received port=" + String(listenPort) + " requestFile=" + (requestWritten ? "ok" : "FAILED"));

      // Let this response reach the browser before the process disappears.
      setTimeout(() => {
        try {
          const child = spawn("wscript.exe", [VBS, String(listenPort)], { detached: true, stdio: "ignore" });
          child.on("error", (error) => log("spawn error: " + (error && error.message)));
          child.unref();
          log("spawn ok pid=" + String(child.pid) + " via " + VBS);
        } catch (error) {
          log("spawn threw: " + (error && error.message));
        }
      }, 800);

      send(res, { ok: true, port: listenPort, message: "restart-triggered", requestWritten });
    },
  });

  log("routes registered: /dsh-restart/status /dsh-restart/restart (port=" + String(listenPort) + ")");
}
