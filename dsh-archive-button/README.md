# dsh-archive-button

> 两个版本：`main` = **vk 版**（只注册 vk 槽，需先装 [dsh-vk-suite](https://github.com/Ln1m/dsh-vk-suite) 契约 + 骨架）；`official` 分支 = **官方挂载版**（零 vk 依赖，挂官方槽）。**推荐 vk 版** —— 位置：左栏底部常驻（`vk.sidebar.footer`）。
> 冲突：一个槽位只渲染优先级最高的一条，同优先级重复注册会直接抛错；与占同一位置的插件互斥（详见 [dsh-vk-suite](https://github.com/Ln1m/dsh-vk-suite) 的「推荐怎么用 / 会跟谁冲突」）。

[English](README.en.md) · 中文

![左栏工作区行的归档按钮界面实拍](assets/dsh-archive-button.png)

*界面实拍：截自本机运行中的 DSH 实例，示例内容已脱敏。*

侧栏工作区标题行上的归档按钮（工作区标题行没挂载时回落到 footer 胶囊）。第一次点先空跑扫描，列出空闲超过 3 天的会话；第二次点把每个会话打包成逐字节校验的 zip，并删掉原目录。host 半端注册 `/dsh-archive/*` 路由并调归档脚本，client 半端只画按钮。模型不会触发它。

## 装

```sh
dsh plugin --profile web add file:<本仓库>
```

装完重启 web 实例。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_ROOT` | `~/DeepSeek_harness` | DSH 安装根；归档目录与按钮日志都由它派生 |

## 前提

- Windows PowerShell 5.1
- 入口槽：`vk.sidebar.footer`（需先装 dsh-vk-suite）
- 归档脚本随本仓库提供（`scripts/archive-dsh-sessions.ps1`），装完即用
- 包内脚本优先；`<DSH_ROOT>\scripts\archive-dsh-sessions.ps1` 存在时作为回退（想用自己那份就放在那里）
- 原会话目录只在 zip 重新打开并逐字节校验通过后才删除
