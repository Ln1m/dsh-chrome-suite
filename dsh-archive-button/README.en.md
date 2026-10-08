# dsh-archive-button

> This branch is the **vk-free build**: official slots only, no vk slot references; identical behaviour with or without dsh-vk-suite. The vk build is on the [main branch](https://github.com/Ln1m/dsh-archive-button/tree/main).

> Two builds: `main` is the **vk build** (vk slots only — install the [dsh-vk-suite](https://github.com/Ln1m/dsh-vk-suite) contract + skeleton first); the `official` branch is the **vk-free build** (no vk dependency, official slots only). **Use the vk build** — position: pinned at the sidebar bottom (`vk.sidebar.footer`).
> Conflicts: a slot renders only its highest-priority entry, and two registrations at the same priority throw; mutually exclusive with anything claiming the same position (see "How to use it / what it conflicts with" in [dsh-vk-suite](https://github.com/Ln1m/dsh-vk-suite)).

[中文](README.md) · English

![Archive button in the sidebar workspace row](assets/dsh-archive-button.png)

*Screenshot of a running DSH instance; demo content is sanitized.*

An archive button on the sidebar's workspace-title row (it falls back to an inline footer capsule when that row is not mounted). The first click dry-runs a scan and lists the sessions idle for more than 3 days; the second click packs each one into a byte-verified zip and deletes the original folder. The host half registers the `/dsh-archive/*` routes and runs the archive script; the client half only draws the button. The model never triggers it.

## Install

```sh
dsh plugin --profile web add file:<this repo>
```

Restart the web instance afterwards.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `DSH_ROOT` | `~/DeepSeek_harness` | DSH install root; the archive directory and button log are derived from it |

## Requirements

- Windows PowerShell 5.1
- Seat: `vk.sidebar.footer` (dsh-vk-suite required)
- The archive script ships with this repo (`scripts/archive-dsh-sessions.ps1`) and works as installed
- The bundled script wins; `<DSH_ROOT>\scripts\archive-dsh-sessions.ps1` is the fallback
- A session folder is deleted only after its zip is reopened and byte-verified
