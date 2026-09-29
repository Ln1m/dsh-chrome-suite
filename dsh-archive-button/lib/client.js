// vk 版：只注册 vk 槽，需先装 dsh-vk-suite（契约 + 骨架）。零 vk 版见 official 分支。
// dsh-archive-button —— Client 半端
// 位置：官方「工作区」标题行（含官方「添加工作区」图标那一行）里、官方 headerActions 之后，
//   只留图标，紧挨「添加工作区」右侧。做法：注册在 sidebar.footer.action 拿到 React 的挂载点，
//   再把**自建宿主节点**（.dab-host，非 React 管理）搬进那一行，用 portal 把按钮渲染进去 ——
//   React 从不追踪宿主节点的父子关系，搬走/搬回都不会让它卸载时找不到目标（直接搬 React 自己
//   的节点会抛 NotFoundError）。目标行不在时（侧栏收起 / 官方会话栏卸载）自动降级为 footer 里的
//   流式胶囊按钮（带「归档」文字），仍然可见，绝不隐藏。
// 交互（删除动作永远由用户亲手确认）：
//   ① 点「归档」→ 扫描 3 天未活动的会话（不动任何文件）
//   ② 弹层显示明细 → 点「确认归档」→ 后台执行 → 显示「已归档 N 个 · 释放 X MB」

window.__ModuleLoader__.load({
  id: 'dsh-archive-button',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    const h = React.createElement;
    // 浮层必须挂到 document.body：本组件根节点 .dab-slot 是定位元素，一旦带 z-index 就会
    // 创建 stacking context —— 浮层留在它内部时 z-index 再高也只在这个"笼子"里排序，对外照样
    // 被更高层级内容遮挡（2026-09-10 实测：z-index 提到 9999 仍被遮挡就是这个原因）。
    let ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch { ReactDOM = null; }

    function insertStyles(css) {
      try {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        return () => { try { style.remove() } catch { /* ignore */ } };
      } catch {
        return () => {};
      }
    }

    const PANEL_W = 286;

    const CSS = `
.dab-slot{display:flex;align-items:center;gap:6px;}
.dab-slot.dab-rail{display:none;}
/* 已落进官方「工作区」标题行时，留在原插槽里的根节点不产生任何盒子（按钮本体已 portal 到那一行） */
.dab-slot.dab-row{display:contents;}
/* 自建宿主节点：按钮 portal 的家。落点是底部「设置」那一行右侧、与设置各占一半（2026-09-29 用户口径） */
.dab-host{display:flex;align-items:center;flex:1 1 0;min-width:0;}
/* 设置行：行内两项等分。官方触发行不带构建哈希之外的信息，用 [class*=triggerRow] 按后缀匹配 */
[class*=triggerRow]{display:flex!important;align-items:center;gap:6px;}
[class*=triggerRow] button[aria-label="设置"]{flex:1 1 0;min-width:0;width:auto;}
/* 侧栏收起成 rail：方向由行变窄，两块都回到图标尺寸、不再等分 */
[class*=collapsed] [class*=triggerRow] button[aria-label="设置"]{flex:0 0 auto;width:auto;}
[class*=collapsed] .dab-host{flex:0 0 auto;}
[class*=collapsed] .dab-host .dab-ibtn{flex:0 0 auto;width:32px;}
.dab-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:15px;background:0 0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:13px;font-weight:400;line-height:20px;cursor:pointer;white-space:nowrap;}
.dab-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.dab-btn:disabled{cursor:default;color:var(--dsw-alias-label-dimmed);}
.dab-btn.dab-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}
.dab-btn.dab-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);}
.dab-btn.dab-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}
.dab-btn svg{display:block;flex:none;}
/* 图标态：进「工作区」行后只留图标，尺寸/圆角对齐官方那两颗 28×28 图标按钮 */
.dab-ibtn{display:inline-flex;align-items:center;justify-content:center;flex:1 1 auto;width:100%;height:32px;padding:0;border:none;border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);font-family:inherit;cursor:pointer;}
.dab-ibtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.dab-ibtn:active:not(:disabled){transform:scale(.94);}
.dab-ibtn:disabled{cursor:default;color:var(--dsw-alias-label-dimmed);}
.dab-ibtn.dab-danger{color:var(--dsw-alias-state-error-primary);}
.dab-ibtn.dab-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);}
.dab-ibtn.dab-ok{color:var(--dsw-alias-state-success-primary);}
.dab-ibtn svg{display:block;flex:none;}
.dab-backdrop{position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.28);}
.dab-panel{position:fixed;z-index:9999;width:${PANEL_W}px;max-width:calc(100vw - 24px);max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,Menu)));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.32);padding:12px;font-size:12px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:8px;word-break:break-word;}
.dab-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.dab-h{font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:6px;}
.dab-x{border:none;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;border-radius:6px;font-family:inherit;}
.dab-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.dab-body{color:var(--dsw-alias-label-secondary);line-height:1.6;font-variant-numeric:tabular-nums;}
.dab-body b{color:var(--dsw-alias-label-primary);font-weight:600;}
.dab-actions{display:flex;align-items:center;gap:8px;}
.dab-act{height:28px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;}
.dab-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.dab-act:disabled{cursor:default;color:var(--dsw-alias-label-dimmed);}
.dab-act.dab-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);}
.dab-act.dab-primary:hover:not(:disabled){filter:brightness(1.08);}
.dab-act.dab-danger{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground);}
.dab-act.dab-danger:hover:not(:disabled){filter:brightness(1.08);}
.dab-msg{display:flex;align-items:flex-start;gap:5px;line-height:1.5;}
.dab-msg svg{display:block;flex:none;margin-top:2px;}
.dab-msg-ok{color:var(--dsw-alias-state-success-primary);}
.dab-msg-warn{color:var(--dsw-alias-state-warn-primary);}
.dab-msg-err{color:var(--dsw-alias-state-error-primary);word-break:break-all;}
.dab-foot{border-top:1px solid var(--dsw-alias-border-l1);padding-top:7px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;font-variant-numeric:tabular-nums;}
`;

    function svgIcon(d, size) {
      return h('svg', { viewBox: '0 0 24 24', width: size || 14, height: size || 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, dangerouslySetInnerHTML: { __html: d } });
    }
    // 两种调用方式都要吃得下：组件式 h(ArchiveIcon) / h(ArchiveIcon, { size }) 与函数式 ArchiveIcon(15)。
    // （React 会把 props 对象当第一个实参传进来，直接拿它当 size 会渲染成 width="[object Object]"）
    function ArchiveIcon(props) {
      const size = typeof props === 'number' ? props : (props && typeof props.size === 'number' ? props.size : 13);
      return svgIcon('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>', size);
    }
    function CheckIcon() { return svgIcon('<path d="M20 6 9 17l-5-5"/>', 12); }
    function WarnIcon() { return svgIcon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>', 12); }

    function fmtTime(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      const p = (n) => String(n).padStart(2, '0');
      return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function ArchiveDock(props) {
      const wide = !(props && props.wide === false);
      const slotRef = React.useRef(null);
      const btnRef = React.useRef(null);
      const hostRef = React.useRef(null);
      const [docked, setDocked] = React.useState(false); // true = 已落进官方「工作区」标题行
      const [open, setOpen] = React.useState(false);
      const [panelStyle, setPanelStyle] = React.useState(null);
      const [phase, setPhase] = React.useState('idle'); // idle | scanning | confirm | running
      const [scan, setScan] = React.useState(null);
      const [view, setView] = React.useState(null);
      const [msg, setMsg] = React.useState(null);

      // 宿主节点只建一次：它由我们直接操作 DOM，React 不把它当子节点管理。
      if (hostRef.current === null && typeof document !== 'undefined') {
        try {
          const d = document.createElement('div');
          d.className = 'dab-host';
          hostRef.current = d;
        } catch { hostRef.current = null; }
      }

      // 落位：找官方「工作区」标题行，把宿主节点插到「添加工作区」图标右边。
      React.useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        if (!wide) { setDocked(false); return; }
        if (!ReactDOM || typeof ReactDOM.createPortal !== 'function') { setDocked(false); return; }

        const findTarget = () => {
          // ① 底部「设置」那一行：落点在设置右侧，与设置各占一半（用户 2026-09-29 口径）
          let settingsBtn = null;
          try { settingsBtn = document.querySelector('button[aria-label="设置"]'); } catch { settingsBtn = null; }
          if (settingsBtn && settingsBtn.parentElement) {
            const row = typeof settingsBtn.closest === 'function' ? settingsBtn.closest('[class*="triggerRow"]') : null;
            if (row) return { row, after: settingsBtn.parentElement };
          }
          // ② 官方「添加工作区」按钮：aria-label 稳定，不含构建哈希
          let addBtn = null;
          try { addBtn = document.querySelector('[aria-label="添加工作区"]'); } catch { addBtn = null; }
          if (addBtn && addBtn.parentElement && addBtn.parentElement.parentElement) {
            // 挂在**行**上、紧跟在 headerActions 之后。不能塞进 headerActions 内部：它是固定 60px 的
            // 两颗图标容器，第三颗会被行尾 overflow:hidden 裁掉（2026-09-11 实测：host 落在 272..300，
            // 行只有 12..272，图标不可见）。挂到行上实测：行内 auto 间距自动让位 28px，官方两颗图标
            // 整体左移，归档图标落在「添加工作区」右边 4px，行宽 260/行高 36 都不变。
            return { row: addBtn.parentElement.parentElement, after: addBtn.parentElement };
          }
          // ③ 退化：按「工作区」标签文字找那一行（类名带哈希，只按后缀匹配）
          let label = null;
          try {
            label = [...document.querySelectorAll('[class*="sectionLabel"]')]
              .find((n) => (n.textContent || '').trim() === '工作区');
          } catch { label = null; }
          if (label) {
            const row = (typeof label.closest === 'function' && label.closest('[class*="sectionHeader"]')) || label.parentElement;
            if (row) return { row, after: null };
          }
          return null;
        };

        const place = () => {
          const t = findTarget();
          if (!t) {
            // 目标行不在（侧栏收起 / 官方会话栏被卸载）：退回内联胶囊按钮，绝不让按钮消失
            if (!host.isConnected) setDocked(false);
            return;
          }
          // 用「行 + 前一个元素兄弟」判在位，避免和空白文本节点比较导致每秒无谓重插
          if (host.parentElement !== t.row || host.previousElementSibling !== t.after) {
            const want = t.after ? t.after.nextElementSibling : null;
            try { t.row.insertBefore(host, want); } catch { setDocked(false); return; }
          }
          setDocked(true);
        };

        place();
        const timer = window.setInterval(place, 1000); // 兜底：官方重渲染换了节点时自动搬回
        return () => {
          window.clearInterval(timer);
          try { if (host.parentElement) host.parentElement.removeChild(host); } catch { /* ignore */ }
        };
      }, [wide]);

      const loadStatus = React.useCallback(async () => {
        try {
          const res = await fetch('/dsh-archive/status', { cache: 'no-store' });
          if (!res.ok) return null;
          const data = await res.json();
          setView(data);
          return data;
        } catch { return null; }
      }, []);

      React.useEffect(() => {
        loadStatus().then((v) => { if (v && v.running) setPhase('running'); });
      }, [loadStatus]);

      // 归档进行中：轮询到结束
      React.useEffect(() => {
        if (phase !== 'running') return;
        let stop = false;
        const tick = async () => {
          if (stop) return;
          const v = await loadStatus();
          if (stop) return;
          if (!v || !v.running) {
            const r = v && v.result;
            if (r && r.mode === 'archive') {
              const bad = r.failed > 0;
              setMsg({ kind: bad ? 'warn' : 'ok', text: '已归档 ' + r.archived + ' 个 · 释放 ' + r.freedMB + ' MB' + (bad ? ' · 失败 ' + r.failed + '，详见日志' : '') });
            } else {
              setMsg({ kind: 'warn', text: '归档未产生结果，请查看 dsh-session-archive.log' });
            }
            setScan(null);
            setPhase('idle');
            return;
          }
          setTimeout(tick, 1500);
        };
        setTimeout(tick, 1200);
        return () => { stop = true; };
      }, [phase, loadStatus]);

      const openPanel = () => {
        const el = btnRef.current || slotRef.current;
        if (el) {
          const r = el.getBoundingClientRect();
          // 浮层宽度按左栏列宽收敛：绝不让它溢出左栏（溢出部分会被主内容区挡住/裁掉）
          let colEl = null;
          try { colEl = el.closest('[class*="sidebarCol"]'); } catch { colEl = null; }
          if (!colEl) { try { colEl = el.closest('[class*="footArea"]'); } catch { colEl = null; } }
          if (!colEl && el.parentElement) colEl = el.parentElement.parentElement;
          const cr = colEl ? colEl.getBoundingClientRect() : null;
          const limit = cr && cr.width > 40 ? Math.floor(cr.width) : PANEL_W;
          const w = Math.max(180, Math.min(PANEL_W, limit));
          const rightEdge = cr && cr.width > 40 ? Math.min(r.right, cr.right - 4) : r.right;
          const style = {
            width: w + 'px',
            left: Math.max(8, Math.round(rightEdge - w)) + 'px',
          };
          // 垂直：优先贴按钮下方；下方不够就翻到上方；两侧都紧就取空间大的一侧并限高。
          const below = Math.round(window.innerHeight - r.bottom - 10);
          const above = Math.round(r.top - 10);
          if (below >= 200 || below >= above) {
            style.top = Math.round(r.bottom + 8) + 'px';
            style.maxHeight = Math.max(120, below) + 'px';
          } else {
            style.bottom = Math.round(window.innerHeight - r.top + 8) + 'px';
            style.maxHeight = Math.max(120, above) + 'px';
          }
          setPanelStyle(style);
        }
        setOpen(true);
      };

      const doScan = async () => {
        if (phase === 'scanning' || phase === 'running') return;
        setPhase('scanning');
        setMsg(null);
        try {
          const res = await fetch('/dsh-archive/scan', { method: 'POST', cache: 'no-store' });
          const data = await res.json();
          if (data && data.ok && data.scan) {
            setScan(data.scan);
            if (data.scan.candidates > 0) setPhase('confirm');
            else { setPhase('idle'); setMsg({ kind: 'ok', text: '没有需要归档的会话（3 天内活跃的全部保留）' }); }
          } else {
            setPhase('idle');
            setMsg({ kind: 'err', text: (data && data.error) || '扫描失败' });
          }
        } catch {
          setPhase('idle');
          setMsg({ kind: 'err', text: '扫描请求失败' });
        }
      };

      const doRun = async () => {
        if (phase !== 'confirm') return;
        setPhase('running');
        setMsg(null);
        try {
          const res = await fetch('/dsh-archive/run', { method: 'POST', cache: 'no-store' });
          const data = await res.json();
          if (!data || !data.ok) {
            setPhase('idle');
            setMsg({ kind: 'err', text: (data && data.error) || '启动归档失败' });
          }
        } catch {
          setPhase('idle');
          setMsg({ kind: 'err', text: '归档请求失败' });
        }
      };

      const onButton = () => {
        if (phase === 'confirm') { doRun(); return; }
        if (open) { setOpen(false); return; }
        openPanel();
        if (!scan && phase === 'idle') doScan();
      };

      const label = phase === 'scanning' ? '扫描中…'
        : phase === 'running' ? '归档中…'
        : phase === 'confirm' ? '确认归档'
        : '归档';
      // 图标态靠 title 传达阶段（按钮面无文字），文字态标题与旧版一致
      const title = phase === 'scanning' ? '正在扫描 3 天未活动的会话…'
        : phase === 'running' ? '归档进行中…'
        : phase === 'confirm' ? '确认归档：再点一次即开始（3 天未活动的会话）'
        : '归档 3 天未活动的会话';
      const btnCls = (docked ? 'dab-ibtn' : 'dab-btn')
        + (phase === 'confirm' ? ' dab-danger' : (phase === 'idle' && msg && msg.kind === 'ok' ? ' dab-ok' : ''));

      const last = view && view.result;
      const lines = [];
      if (phase === 'scanning') lines.push(h('div', { className: 'dab-body', key: 's' }, '正在扫描 3 天未活动的会话…'));
      if (phase === 'confirm' && scan) {
        lines.push(h('div', { className: 'dab-body', key: 'c1', title: '打包为 zip 存入 archive\\dsh-sessions；逐个校验字节一致后才移出原目录（可还原）' }, '待归档 ', h('b', null, scan.candidates + ' 个'), ' · ', h('b', null, scan.totalMB + ' MB')));
        lines.push(h('div', { className: 'dab-body', key: 'c2', title: '3 天内活跃的会话不动' }, '保留 ', h('b', null, scan.skippedActive + ' 个')));
      }
      if (phase === 'running') lines.push(h('div', { className: 'dab-body', key: 'r', title: '打包后逐个校验字节一致才移出原目录，请勿关闭 DSH' }, '归档中…'));
      if (!lines.length && msg) {
        const Icon = msg.kind === 'ok' ? CheckIcon : WarnIcon;
        lines.push(h('div', { className: 'dab-msg dab-msg-' + msg.kind, key: 'm' }, h(Icon), h('span', null, msg.text)));
      }

      const actions = [];
      if (phase === 'confirm') {
        actions.push(h('button', { type: 'button', className: 'dab-act dab-danger', key: 'go', onClick: doRun }, '确认归档'));
        actions.push(h('button', { type: 'button', className: 'dab-act', key: 'no', onClick: () => { setPhase('idle'); setScan(null); } }, '取消'));
      } else if (phase === 'idle') {
        actions.push(h('button', { type: 'button', className: 'dab-act dab-primary', key: 'scan', onClick: doScan, title: '扫描 3 天未活动的会话' }, '扫描'));
      }

      const panelContent = open ? h(React.Fragment, null,
        h('div', { className: 'dab-backdrop', onClick: () => setOpen(false) }),
        h('div', { className: 'dab-panel', style: panelStyle || { left: 8, bottom: 60, width: PANEL_W + 'px' }, role: 'dialog', 'aria-label': '归档会话' },
          h('div', { className: 'dab-head' },
            h('span', { className: 'dab-h' }, h(ArchiveIcon), '归档会话'),
            h('button', { type: 'button', className: 'dab-x', onClick: () => setOpen(false), 'aria-label': '关闭', title: '关闭' }, '×'),
          ),
          lines.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, lines) : null,
          actions.length ? h('div', { className: 'dab-actions' }, actions) : null,
          last && last.mode === 'archive'
            ? h('div', { className: 'dab-foot' }, '上次归档 ' + fmtTime(last.finishedAt) + ' · ' + last.archived + ' 个 · 释放 ' + last.freedMB + ' MB' + (last.failed > 0 ? ' · 失败 ' + last.failed : ''))
            : null,
        ),
      ) : null;

      // portal 到 body：脱离左栏所有祖先的 stacking context 与裁剪
      const canPortal = panelContent && ReactDOM && typeof ReactDOM.createPortal === 'function'
        && typeof document !== 'undefined' && document.body;
      const panel = canPortal ? ReactDOM.createPortal(panelContent, document.body) : panelContent;

      // 只能留图标时把 label 交给 title / aria-label，保证阶段仍可识别、无障碍名称不丢
      const button = h('button', {
        ref: btnRef,
        type: 'button',
        className: btnCls,
        onClick: onButton,
        disabled: phase === 'scanning' || phase === 'running',
        title,
        'aria-label': docked ? '归档会话·' + label : '归档会话',
      },
        h(ArchiveIcon, { size: docked ? 15 : 13 }),
        docked ? null : h('span', null, label));

      const content = h(React.Fragment, null, button, panel);

      return h('div', {
        ref: slotRef,
        className: 'dab-slot' + (wide ? '' : ' dab-rail') + (docked ? ' dab-row' : ''),
        'data-dab-pos': docked ? 'row' : 'inline',
      },
        docked && hostRef.current && ReactDOM && typeof ReactDOM.createPortal === 'function'
          ? ReactDOM.createPortal(content, hostRef.current)
          : content,
      );
    }

    const inject = ['slots'];
    function apply(ctx) {
      insertStyles(CSS);
      const slots = ctx.get('slots');
      if (slots === undefined) {
        console.warn('[dsh-archive-button] slots service unavailable');
        return;
      }
      slots.inject('vk.sidebar.footer', () => slots.register(
        { name: 'vk.sidebar.footer', id: 'dsh-archive-button', order: 90, label: '归档会话' },
        (props) => (h(ArchiveDock, props)),
      ));
      console.log('[dsh-archive-button] client applied');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
