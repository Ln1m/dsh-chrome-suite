# dsh-chrome-suite

[中文](README.md) | English

Window chrome: restart button, session archive button, wallet

## Packages

| Directory | What it does |
|---|---|
| `dsh-restart-button` | Two-click Restart DSH in the session header, restarts exactly this instance |
| `dsh-archive-button` | Two-click archive: zips sessions idle for more than 3 days, deletes the originals |
| `dsh-wallet` | Balance, per-session cost, peak/off-peak pricing, one-click recharge |

## Install

```sh
# one package
dsh plugin --profile web add file:<this repo>/dsh-restart-button
```

Or install the whole family on Windows PowerShell:

```powershell
./install.ps1
```

Restart the web instance afterwards. Each package directory carries its own README.

## Screenshots

![dsh-restart-button](dsh-restart-button/assets/dsh-restart-button.png)

![dsh-archive-button](dsh-archive-button/assets/dsh-archive-button.png)

![dsh-wallet](dsh-wallet/assets/screenshot-panel-light.png)

## License

MIT
