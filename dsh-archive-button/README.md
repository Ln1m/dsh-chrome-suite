# dsh-archive-button（会话归档按钮）

> 本分支是 **vk 版**：只注册 vk 槽，需先装 [dsh-vk-suite](https://github.com/Ln1m/dsh-vk-suite)（契约 + 骨架）。零 vk 版见 [official 分支](https://github.com/Ln1m/dsh-archive-button/tree/official)。

在左栏里放一个「归档」按钮：侧栏展开时落进官方**「工作区」标题行**、紧挨「添加工作区」图标右侧；那一行不在时退回页脚胶囊按钮。

## 位置与外观

- 注册 Slot：`sidebar.footer.action`（order 90）。
- **落位**：把自建宿主节点（`.dab-host`，非 React 管理）搬进官方「工作区」标题行（按文本找到那一行的 `sectionHeader`），再用 portal 把按钮渲染进去 —— React 不追踪宿主节点的父子关系，搬走/搬回都不会在卸载时找不到目标。官方重渲染换掉节点时，每秒一次的重试会自动搬回原位。
- **图标态**：进「工作区」行后只留图标（28×28，尺寸/圆角对齐官方那两颗图标按钮），文字收进 `title` / `aria-label`，配无障碍名称。
- **退回态**：目标行不存在（官方会话栏卸载等）时退回页脚，渲染为胶囊按钮（图标 + 文字，文字随阶段变化，如「扫描中…」），不会消失。
- **侧栏收起**（56px 图标栏）时不显示——那一行放不下。
- **浮层**：portal 到 `document.body`（脱离左栏所有祖先的 stacking context 与裁剪），宽度按左栏列宽收敛，垂直方向按剩余空间自动朝上/朝下并限高。
- 全部颜色走 DSH 主题 token（`--dsw-*`），深浅色自适应；图标为内联 SVG（`stroke=currentColor`），无 emoji。

## 交互流程

| 步骤 | 动作 | 结果 |
|---|---|---|
| ① | 点「归档」 | 弹出浮层并干跑扫描（`-DryRun`），不改动任何文件；显示待归档个数 / 体积 / 3 天内活跃保留数 |
| ② | 点浮层里的「确认归档」 | 后台真正执行；按钮与浮层显示「归档中…」，前端每 1.5s 轮询进度 |
| ③ | 完成 | 浮层显示「已归档 N 个 · 释放 X MB」（有失败会标红并提示看日志） |

删除动作永远需要用户亲手点第二下——模型不会触发本插件。

## 归档规则

- 只归档**最后活动时间超过 3 天**的会话（`%USERPROFILE%\.dsh\sessions\<工作区>\<会话id>\`），3 天内的活跃会话一律不动。
- 每个会话先打包成 zip，**重新打开 zip 逐条比对条目数与字节总数**，完全一致才删除原目录；任何一个不一致就保留原目录并记 ERROR。
- zip 位置：`<DSH 安装根>\archive\dsh-sessions\<工作区>\<yyyy-MM>\<会话id>.zip`（源文件已是 zstd 压缩，zip 用 store 模式，只做容器，速度快且无损）。
- 归档后该会话不再出现在 GUI 历史列表里——数据在 zip 中，随时可还原。

## 还原

设置页「已归档会话 · ZIP 归档」列的就是这里的 zip，一键走 `POST /dsh-archive/restore`（同一支还原脚本）；命令行等价：

```powershell
# 单个会话
powershell -NoProfile -ExecutionPolicy Bypass -File <DSH 安装根>\scripts\restore-dsh-session.ps1 -Zip "<DSH 安装根>\archive\dsh-sessions\--D-Desktop-DeepSeek--\2026-08\<会话id>.zip"
# 整月整批还原
powershell -NoProfile -ExecutionPolicy Bypass -File <DSH 安装根>\scripts\restore-dsh-session.ps1 -Zip "<DSH 安装根>\archive\dsh-sessions\--D-Desktop-DeepSeek--\2026-08" -All
```

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 半端：`/dsh-archive/status`、`/dsh-archive/scan`、`/dsh-archive/run`、`/dsh-archive/list`、`/dsh-archive/restore` 五个路由，负责静默拉起 PowerShell |
| `lib/client.js` | Client 半端：左栏按钮与浮层组件 |
| `cordis.patch.yml` | 把插件插入 web profile 的 layer stack |
| `<DSH 安装根>\scripts\archive-dsh-sessions.ps1` | 归档执行脚本（可独立命令行运行，含 `-DryRun` / `-Force` / `-DaysOld`） |
| `<DSH 安装根>\scripts\restore-dsh-session.ps1` | 还原脚本 |
| `<DSH 安装根>\logs\dsh-session-archive.log` | 归档日志（每次运行逐条记录） |
| `<DSH 安装根>\logs\dsh-archive-button.log` | 按钮插件日志（路由调用与进程退出码） |
| `<DSH 安装根>\archive\dsh-sessions\.last-result.json` | 最近一次归档结果（前端读取） |
| `<DSH 安装根>\archive\dsh-sessions\.scan-result.json` | 最近一次扫描结果（前端读取） |

命令行手动跑（不经按钮）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <DSH 安装根>\scripts\archive-dsh-sessions.ps1 -DryRun   # 只看清单
powershell -NoProfile -ExecutionPolicy Bypass -File <DSH 安装根>\scripts\archive-dsh-sessions.ps1 -Force    # 立即归档
```
