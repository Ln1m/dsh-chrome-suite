# dsh-restart-button

> 本分支是 **vk 版**：只注册 vk 槽，需先装 [dsh-vk-suite](https://github.com/Ln1m/dsh-vk-suite)（契约 + 骨架）。零 vk 版见 [official 分支](https://github.com/Ln1m/dsh-head-restart/tree/official)。
> **两个版本推荐用 vk 版**：左栏的 Tab 切换（会话 / 文件 / 任务 / 工具）与右栏、设置的位置都由 [dsh-vk-suite](https://github.com/Ln1m/dsh-vk-suite)（契约 + 骨架）提供，vk 版才装得进这些位置；官方挂载版不依赖骨架，只挂官方槽，形态受官方界面限制。

[English](README.en.md) · 中文

![会话头右侧的重启按钮界面实拍](assets/dsh-restart-button.png)

*界面实拍：截自本机运行中的 DSH 实例，示例内容已脱敏。*

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
| `DSH_ROOT` | `~/DeepSeek_harness` | 日志与重启请求文件的落点 |

## 前提

- Windows：重启链是 wscript → powershell，完全脱离 web 进程
- 重启脚本随本仓库提供（`scripts/dsh-restart-instance.vbs` + `scripts/dsh-restart-instance.ps1`），装完即用
- 包内脚本优先；`<DSH_ROOT>\scripts\dsh-restart-instance.vbs` 存在时作为回退（想用自己那份就放在那里）
