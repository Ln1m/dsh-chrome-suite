# dsh-wallet

> 两个版本：`main` = **vk 版**（只注册 vk 槽，需先装 [dsh-vk-suite](https://github.com/Ln1m/dsh-vk-suite) 契约 + 骨架）；`official` 分支 = **官方挂载版**（零 vk 依赖，挂官方槽）。**推荐 vk 版** —— 位置：左栏底部常驻（`vk.sidebar.footer`）。
> 冲突：一个槽位只渲染优先级最高的一条，同优先级重复注册会直接抛错；与占同一位置的插件互斥（详见 [dsh-vk-suite](https://github.com/Ln1m/dsh-vk-suite) 的「推荐怎么用 / 会跟谁冲突」）。

[English](README.en.md) · 中文

DeepSeek Harness（DSH）钱包插件 —— 左栏底部常驻面板，显示 **DeepSeek 账户余额**、**今日累计**、**本会话消耗**（悬停展开 token / 金额明细）与**可编辑提醒阈值**，一键打开官方充值 / API Key / 用量页；另注册模型工具 `query_deepseek_balance`。**需先装 dsh-vk-suite**：面板落在它的 `vk.sidebar.footer` 槽（竖排常驻面板）。

## ✨ 功能

| 模块 | 能力 |
| --- | --- |
| 余额查询 | 官方 `GET api.deepseek.com/user/balance`（Bearer 鉴权，读 DSH 凭据 `DEEPSEEK_API_KEY`），CNY / USD 双余额池，30 秒缓存；失败按 5s → 5min 指数退避重试 |
| 今日累计 | 本地 session/event 事件流**分日聚合**，与「本会话消耗」同源（今日累计 ≥ 本会话的今日部分，不会出现假矛盾）。官方账单接口按小时桶结算、最近约 10~20 分钟未入账，只作后台校准参考，不作展示口径 |
| 会话成本 | `sessionProjections` 的 tokenUsage × 价格表实时估算；`reasoningTokens` 已含在 `outputTokens` 内只计一次；悬停展开输入 / 缓存命中 / 输出明细 |
| 峰谷计价 | 北京时间自动切档：**周末全天空闲价**，工作日 9:00–12:00、14:00–18:00 为高峰价（2026-08-17 00:00 起生效；Flash 于 2026-09-10 12:00 再次调价） |
| 低余额告警 | CNY < ¥10 或 USD < $2 时标黄 |
| 提醒阈值 | 单会话可编辑（默认 ¥5），**持久化**到 `~/.dsh/dsh-wallet.json`；超限提示新建对话 |
| 系统通知 | 低余额 / 超阈值时浏览器系统通知，仅在状态转变时各触发一次 |
| 一键跳转 | 面板底部「充值 / API Key / 明细」三个按钮 |
| 模型工具 | `query_deepseek_balance` |

> 面板数字是**本地估算**；与官方账单不符时以官方为准。

## 🖼 界面

深色主题：

![深色](https://cdn.jsdelivr.net/gh/Ln1m/dsh-foot-wallet@main/assets/screenshot-panel.png)

浅色主题：

![浅色](https://cdn.jsdelivr.net/gh/Ln1m/dsh-foot-wallet@main/assets/screenshot-panel-light.png)

面板可折叠：收起态一行「● 钱包 ¥30.39 CNY ↻ ⌄」，展开态：

```
钱包                        ↻  ⌄
余额                   ¥30.39 CNY
今日累计               ¥70.30
本会话消耗 ¥1.23 [高峰价]   ← 悬停展开 token/金额明细
提醒阈值   ¥[5.00]
[充值] [API Key] [明细]
```

## 🏗 架构

```
Host（Node 进程）
├─ 余额：原生 fetch → api.deepseek.com/user/balance（30s 缓存 + 指数退避）
├─ 今日累计：session/event 事件流分日聚合；官方 platform /api/v0/usage 作后台校准
├─ 会话成本：sessionProjections.tokenUsage × 价格表（flash/pro，含峰谷）
├─ 阈值持久化：~/.dsh/dsh-wallet.json（启动加载，修改即存）
├─ 路由：/wallet/api/balance · refresh · cost?session=<id> · usage · set-threshold
└─ 模型工具：query_deepseek_balance

Client（浏览器）
├─ 入口：vk.sidebar.footer（常驻面板，需先装 dsh-vk-suite）
├─ 内容：余额 + 今日累计 + 本会话消耗 + 提醒阈值 + 充值/API Key/明细
├─ 当前会话 id 经 useSyncExternalStore 订阅 sessions.list，切换会话即时刷新
└─ 系统通知：低余额 / 超阈值（Notification API）
```

## 📦 安装 / 更新

本机安装走本地真源：

```powershell
$bin = "<DSH 安装根>\node_modules\@deepseek-ai\dsh\lib\bin.js"
node $bin plugin --profile web remove dsh-wallet
node $bin plugin --profile web add file:D:/DeepSeek_harness/plugins/dsh-wallet
```

源码真源：本仓库。改完源码须 remove + add 刷新运行副本（`~\.dsh\profiles\web\node_modules\dsh-wallet`），再重启 DSH。

> 「充值 / API Key / 明细」要在 DSH 窗口内打开官方页，需要桌面端 dsh-desktop 处理 `NewWindowRequested` 事件，见 [`docs/DESKTOP-EMBED.md`](docs/DESKTOP-EMBED.md)。

## 📊 官方用量（可选）

配好 `userToken` 后，官方账单数据只作**后台校准参考**（返回在 `/wallet/api/usage` 的 `official` / `officialToday` 字段），面板「今日累计」始终走本地实时聚合：

1. 浏览器登录 [platform.deepseek.com](https://platform.deepseek.com)，F12 → Console 执行 `localStorage.getItem('userToken')`，复制返回 JSON 里的 `.value` 字段（不是 `sk-` 开头的 API Key）
2. 写入 `~/.dsh/dsh-wallet.json` 的 `platformToken` 字段（或设 DSH 凭据 `DEEPSEEK_PLATFORM_TOKEN`）
3. 重启 `dsh web`

> `userToken` 是**会话级**的，会过期。失效后插件静默回退本地统计。

## 💰 价格表（元 / 百万 token）

2026-09-10 12:00 起现行：

| 模型 | 档位 | 缓存命中输入 | 未命中输入 | 输出 |
| --- | --- | --- | --- | --- |
| deepseek-v4-flash | 空闲价 | 0.02 | 1 | 4 |
| deepseek-v4-flash | 高峰价 | 0.04 | 2 | 8 |
| deepseek-v4-pro | 空闲价 | 0.15 | 4.5 | 13.5 |
| deepseek-v4-pro | 高峰价 | 0.30 | 9.0 | 27.0 |

- 峰谷计价自北京时间 2026-08-17 00:00 起生效；2026-08-17 之前的历史事件按基础价计（未命中输入 / 缓存命中输入 / 输出：flash 1 / 0.02 / 2，pro 3 / 0.025 / 6）。
- 非峰谷的基础价会尝试从官方定价页抓取覆盖；峰谷价无公开解析标准，用插件内置硬编码。

## 许可

MIT。会话成本计价思路参考 [dsh-balance-meter](https://github.com/Ghost011118/dsh-balance-meter)（MIT）、[dsh-balance-plugin](https://github.com/Francis-Xavier-code/dsh-balance-plugin)（MIT）。
