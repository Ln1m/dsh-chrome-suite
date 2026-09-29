# dsh-restart-button

> Two builds: `main` is the **vk build** (vk slots only — install the [dsh-vk-suite](https://github.com/Ln1m/dsh-vk-suite) contract + skeleton first); the `official` branch is the **vk-free build** (no vk dependency, official slots only). **Use the vk build** — position: the session header, top right (`conversation.session.header.corner`).
> Conflicts: a slot renders only its highest-priority entry, and two registrations at the same priority throw; mutually exclusive with anything claiming the same position (see "How to use it / what it conflicts with" in [dsh-vk-suite](https://github.com/Ln1m/dsh-vk-suite)).

[中文](README.md) · English

![Restart button at the right end of the session header](assets/dsh-restart-button.png)

*Screenshot of a running DSH instance; demo content is sanitized.*

A two-click-confirm "Restart DSH" button in the session header. It first captures this process's own listen port, node executable, entry script, working directory and argv, writes them to a request file, and hands it to a detached process that restarts exactly that instance — when two instances share one Harness home, clicking restart in A no longer kills B.

Only the user triggers it; the model never does.

## Install

```sh
dsh plugin --profile web add file:<this repo>
```

Restart the web instance afterwards.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `DSH_ROOT` | `~/DeepSeek_harness` | Where the log and the restart request file go |

## Requirements

- Windows: the restart chain is wscript → powershell, entirely outside the web process
- The restart scripts ship with this repo (`scripts/dsh-restart-instance.vbs` + `scripts/dsh-restart-instance.ps1`) and work as installed
- The bundled scripts win; `<DSH_ROOT>\scripts\dsh-restart-instance.vbs` is the fallback
