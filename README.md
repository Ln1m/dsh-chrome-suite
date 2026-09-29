# dsh-chrome-suite

中文 | [English](README.en.md)

窗口边框部件：重启按钮、归档按钮、钱包

## 包

| 目录 | 作用 |
|---|---|
| `dsh-restart-button` | 会话头两击确认「重启 DSH」，按本进程身份重启同一实例 |
| `dsh-archive-button` | 侧栏两击确认归档：把空闲超过 3 天的会话压成 zip 并删除原目录 |
| `dsh-wallet` | 余额 / 本会话消耗 / 峰谷价，一键充值 |

## 装

```sh
# 只装其中一个包
dsh plugin --profile web add file:<本仓库>/dsh-restart-button
```

整族一次装完（Windows PowerShell）：

```powershell
./install.ps1
```

不克隆仓库、直接从 Release 装（一行一个包）：

```sh
dsh plugin --profile web add "https://github.com/Ln1m/dsh-chrome-suite/releases/download/v0.1.0/dsh-restart-button-0.1.0.tgz"
dsh plugin --profile web add "https://github.com/Ln1m/dsh-chrome-suite/releases/download/v0.1.0/dsh-archive-button-0.1.0.tgz"
dsh plugin --profile web add "https://github.com/Ln1m/dsh-chrome-suite/releases/download/v0.1.0/dsh-wallet-1.3.1.tgz"
```

装完重启 web 实例。每个包目录里还有它自己的 README。

## 界面

![dsh-restart-button](dsh-restart-button/assets/dsh-restart-button.png)

![dsh-archive-button](dsh-archive-button/assets/dsh-archive-button.png)

![dsh-wallet](dsh-wallet/assets/screenshot-panel-light.png)

## 许可

MIT
