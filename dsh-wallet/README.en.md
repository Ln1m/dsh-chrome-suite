# dsh-wallet

> This branch is the **vk-free build**: official slots only, no vk slot references; identical behaviour with or without dsh-vk-suite. The vk build is on the [main branch](https://github.com/Ln1m/dsh-wallet/tree/main).

A DeepSeek Harness (DSH) wallet plugin — a persistent panel at the bottom of the left sidebar showing your **DeepSeek account balance**, **today's total**, **current-session cost** (hover for the token / cost breakdown) and an **editable alert threshold**, with one-click links to the official recharge / API-key / usage pages, plus the model tool `query_deepseek_balance`. **No vk-suite dependency**: the panel lands in the official `sidebar.footer.action` slot as a wallet icon that pops the panel upward.

## ✨ Features

| Module | What it does |
| --- | --- |
| Balance | Official `GET api.deepseek.com/user/balance` (Bearer auth via the DSH credential `DEEPSEEK_API_KEY`) for the CNY / USD pools; 30s cache, exponential backoff from 5s up to 5min on failure |
| Today's total | Local **per-day aggregation** over the session/event stream, sharing its source with the session cost (today ≥ the session's own share today). The official billing endpoint is hourly-bucketed and lags ~10–20 min, so it is used **only as background calibration** |
| Session cost | `sessionProjections` tokenUsage × price table; `reasoningTokens` are already included in `outputTokens` and counted once; hover for input / cache-hit / output breakdown |
| Peak pricing | Auto-switched by Beijing time: **weekends, Chinese public holidays and make-up working weekends are off-peak all day**; weekdays 9:00–12:00 and 14:00–18:00 are peak, excluding Chinese public holidays (effective 2026-08-17 00:00; Flash repriced again at 2026-09-10 12:00) |
| Low-balance alert | Amber warning when CNY < ¥10 or USD < $2 |
| Alert threshold | Editable per session (default ¥5), **persisted** to `~/.dsh/dsh-wallet.json`; warns to start a new chat when exceeded |
| System notifications | Browser notification on low balance / over threshold, once per state transition |
| One-click links | "Recharge / API Key / Usage" buttons at the bottom of the panel |
| Model tool | `query_deepseek_balance` |

> Panel numbers are a **local estimate**; the official bill wins whenever they disagree.

## 🖼 Screenshots

Dark theme:

![dark](https://cdn.jsdelivr.net/gh/Ln1m/dsh-wallet@main/assets/screenshot-panel.png)

Light theme:

![light](https://cdn.jsdelivr.net/gh/Ln1m/dsh-wallet@main/assets/screenshot-panel-light.png)

The panel collapses to one line — "● Wallet ¥30.39 CNY ↻ ⌄" — and expands to:

```
Wallet                      ↻  ⌄
Balance                ¥30.39 CNY
Today                  ¥70.30
This session ¥1.23 [peak]   ← hover for token / cost detail
Alert threshold  ¥[5.00]
[Recharge] [API Key] [Usage]
```

## 🏗 Architecture

```
Host (Node process)
├─ Balance: native fetch → api.deepseek.com/user/balance (30s cache + backoff)
├─ Today: per-day aggregation over the session/event stream; official platform /api/v0/usage as calibration
├─ Session cost: sessionProjections.tokenUsage × price table (flash/pro, peak-aware)
├─ Threshold persistence: ~/.dsh/dsh-wallet.json (loaded on boot, saved on change)
├─ Routes: /wallet/api/balance · refresh · cost?session=<id> · usage · set-threshold
└─ Model tool: query_deepseek_balance

Client (browser)
├─ Entry: sidebar.footer.action (icon form, panel pops upward)
├─ Content: balance + today + session cost + threshold + Recharge/API Key/Usage
├─ Current session id via useSyncExternalStore over sessions.list
└─ System notifications: low balance / over threshold (Notification API)
```

## 📦 Install / update

On this machine the local source is the single source of truth:

```powershell
$bin = "<DSH install root>\node_modules\@deepseek-ai\dsh\lib\bin.js"
node $bin plugin --profile web remove dsh-wallet
node $bin plugin --profile web add file:<DSH 安装根>/plugins/dsh-wallet
```

Source of truth: this repository. After editing the source you must remove + add to refresh the running copy (`~\.dsh\profiles\web\node_modules\dsh-wallet`), then restart DSH.

> Opening the recharge / API-key pages inside the DSH window requires the dsh-desktop app to handle the `NewWindowRequested` event. See [`docs/DESKTOP-EMBED.md`](docs/DESKTOP-EMBED.md).

## 📊 Official usage (optional)

Once a `userToken` is configured, the official billing data is used **only as background calibration** (returned in the `official` / `officialToday` fields of `/wallet/api/usage`); the panel's "Today" always comes from the local live aggregation:

1. Sign in at [platform.deepseek.com](https://platform.deepseek.com), open DevTools → Console, run `localStorage.getItem('userToken')`, and copy the `.value` field (NOT the `sk-` API key)
2. Write it to the `platformToken` field of `~/.dsh/dsh-wallet.json` (or set the DSH credential `DEEPSEEK_PLATFORM_TOKEN`)
3. Restart `dsh web`

> The `userToken` is session-scoped and expires. When it does, the plugin silently falls back to local stats.

## 💰 Price table (CNY per million tokens)

Effective from 2026-09-10 12:00:

| Model | Band | Input (cache hit) | Input (miss) | Output |
| --- | --- | --- | --- | --- |
| deepseek-v4-flash | off-peak | 0.02 | 1 | 4 |
| deepseek-v4-flash | peak | 0.04 | 2 | 8 |
| deepseek-v4-pro | off-peak | 0.15 | 4.5 | 13.5 |
| deepseek-v4-pro | peak | 0.30 | 9.0 | 27.0 |

- Peak pricing took effect at 2026-08-17 00:00 Beijing time; events before that are billed at base prices (input miss / cache hit / output: flash 1 / 0.02 / 2, pro 3 / 0.025 / 6).
- The non-peak base prices are refreshed from the official pricing page; the peak bands have no public machine-readable form and stay hard-coded.
- The per-day holiday table (State Council 2026 arrangement, 国办发明电〔2025〕7 号) is built into `lib/index.js` as `CN_HOLIDAYS`; **extend it every year** — years absent from the table fall back to the weekend-only rule.

## License

MIT. Session-cost pricing follows [dsh-balance-meter](https://github.com/Ghost011118/dsh-balance-meter) (MIT) and [dsh-balance-plugin](https://github.com/Francis-Xavier-code/dsh-balance-plugin) (MIT).
