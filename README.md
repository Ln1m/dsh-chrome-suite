# dsh-restart-button

[English](README.en.md) · 中文

![归档按钮与重启按钮（含两击确认态）界面示意](assets/dsh-archive-button-restart-button.png)

*界面示意：按官方主题变量渲染的版式，非实机截图。*

会话头上一枚两击确认的「重启 DSH」按钮。它先抓本进程的监听端口、node 可执行文件、入口脚本、工作目录与 argv，写成请求文件后交给独立进程按这套身份重启同一个实例——两个实例共用一份 Harness home 时，不会在 A 里点重启却杀掉 B。

只用用户点，模型永远不触发。

## 装

```sh
dsh plugin --profile web add file:<本仓库>
```

装完重启 web 实例。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_ROOT` | `~/DeepSeek_harness` | 用来找 `scripts/dsh-restart-instance.vbs` 并写日志 |

## 前提

- Windows：重启链是 wscript → powershell，完全脱离 web 进程
- `<DSH_ROOT>\scripts\dsh-restart-instance.vbs` 需自备
