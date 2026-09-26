# dsh-restart-button

[中文](README.md) · English

![Archive and restart buttons, including the two-click confirm state](assets/dsh-archive-button-restart-button.png)

*Mockup: layout rendered from the official theme tokens, not a screenshot of a running instance.*

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
| `DSH_ROOT` | `~/DeepSeek_harness` | Used to locate `scripts/dsh-restart-instance.vbs` and to write logs |

## Requirements

- Windows: the restart chain is wscript → powershell, entirely outside the web process
- `<DSH_ROOT>\scripts\dsh-restart-instance.vbs` must be provided by you
