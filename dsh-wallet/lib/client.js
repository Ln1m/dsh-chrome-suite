// vk 版：只注册 vk 槽，需先装 dsh-vk-suite（契约 + 骨架）。零 vk 版见 official 分支。
// dsh-wallet —— Client 半端
// 入口：左栏下方常驻面板（sidebar.footer.action slot）。
// 功能：余额 + 本会话消耗 + 今日累计 + 消耗上限 + 系统通知（紧凑模式，已移除近 7 天趋势折线图）。
// 布局（可折叠，默认收起为单行）：
//   收起：● DeepSeek 钱包  ¥123.45 CNY  [↻] [▾]
//   展开：+ 余额 / 今日累计 / 本会话消耗 / 提醒阈值 / 充值·API Key·明细

window.__ModuleLoader__.load({
  id: 'dsh-wallet',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    const h = React.createElement;

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

    async function apiGet(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    }

    const POLL_MS = 30000;
    const COST_POLL_MS = 5000;
    const RECHARGE_URL = 'https://platform.deepseek.com/top_up';
    const API_KEYS_URL = 'https://platform.deepseek.com/api_keys';
    const USAGE_URL = 'https://platform.deepseek.com/usage';

    function fmt(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return '--';
      return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtTokens(v) {
      const n = Number(v) || 0;
      if (n >= 1000000000) return (n / 1000000000).toFixed(2) + 'B';
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return String(Math.round(n));
    }

    function notify(title, body) {
      try {
        if (typeof Notification === 'undefined') return;
        const fire = () => { try { new Notification(title, { body: body || '' }); } catch { /* ignore */ } };
        if (Notification.permission === 'granted') fire();
        else if (Notification.permission === 'default') {
          Notification.requestPermission().then((p) => { if (p === 'granted') fire(); }).catch(() => {});
        }
      } catch { /* ignore */ }
    }

    const CSS = `
body{--vk-accent:var(--dsw-alias-accent,var(--dsw-alias-state-business-primary));--vk-accent-ring:color-mix(in srgb,var(--vk-accent) 22%,transparent);--vk-accent-soft:color-mix(in srgb,var(--vk-accent) 12%,transparent);--vk-ok:#73c991;--vk-danger:var(--dsw-alias-state-error-primary,#f14c4c);--vk-danger-soft:color-mix(in srgb,var(--vk-danger) 35%,transparent);--vk-fg:var(--dsw-alias-label-primary);--vk-fg2:var(--dsw-alias-label-secondary);--vk-fg3:var(--dsw-alias-label-tertiary);--vk-line:var(--dsw-alias-border-l1);--vk-line2:var(--dsw-alias-border-l2);--vk-bg-hover:var(--dsw-alias-interactive-bg-hover);--vk-r-xs:4px;--vk-r-sm:6px;--vk-r-md:8px;--vk-r-lg:12px;--vk-r-pill:999px;--vk-fs-xs:11px;--vk-fs-sm:12px;--vk-fs-md:13px;--vk-fs-lg:14px;--vk-dur:.12s;--vk-ease:cubic-bezier(.2,.7,.3,1);--vk-fade:background-color var(--vk-dur) var(--vk-ease),color var(--vk-dur) var(--vk-ease),border-color var(--vk-dur) var(--vk-ease),opacity var(--vk-dur) var(--vk-ease);--vk-ring:0 0 0 2px var(--vk-accent-ring);}
.dsw_dock{box-sizing:border-box;width:100%;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill);display:flex;flex-direction:column;padding:6px 10px 8px;font-size:var(--vk-fs-xs);color:var(--dsw-alias-label-primary);position:relative;overflow:visible;}
.dsw_dock_head{display:flex;align-items:center;gap:6px;min-height:20px;flex:none;}
.dsw_dock_title{font-weight:600;font-size:var(--vk-fs-xs);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;user-select:none;}
.dsw_balance_inline{font-size:var(--vk-fs-xs);font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);flex:none;white-space:nowrap;}
.dsw_collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .25s ease;}
.dsw_collapse.dsw_open{grid-template-rows:1fr;}
.dsw_collapse_inner{overflow:hidden;min-height:0;opacity:0;transition:opacity .18s ease;}
.dsw_collapse.dsw_open .dsw_collapse_inner{opacity:1;}
.dsw_dock_body_inner{display:flex;flex-direction:column;gap:6px;padding-top:6px;}
.dsw_dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:none;}
.dsw_dot_ok{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;}
.dsw_balance_value{font-size:var(--vk-fs-lg);font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap;}
.dsw_row{display:flex;align-items:center;justify-content:space-between;gap:8px;line-height:1.3;min-height:16px;}
.dsw_row_label{font-size:10px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:5px;flex:none;}
.dsw_row_value{font-size:var(--vk-fs-sm);font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsw_band{display:inline-flex;align-items:center;justify-content:center;padding:0 5px;border-radius:var(--vk-r-pill);font-size:9px;line-height:1.5;font-weight:600;flex:none;white-space:nowrap;box-sizing:border-box;}
.dsw_band.base{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);}
.dsw_band.peak{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 22%,transparent);color:var(--dsw-alias-state-warn-primary);}
.dsw_band.offpeak{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 20%,transparent);color:var(--dsw-alias-state-success-primary);}
.dsw_threshold_wrap{display:inline-flex;align-items:center;gap:3px;}
.dsw_threshold_symbol{color:var(--dsw-alias-label-secondary);font-size:var(--vk-fs-sm);}
.dsw_threshold_input{width:5ch;min-width:5ch;background:transparent;border:none;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:0;padding:1px 2px;font-size:var(--vk-fs-sm);font-family:inherit;text-align:center;font-variant-numeric:tabular-nums;box-sizing:border-box;-moz-appearance:textfield;}
.dsw_threshold_input::-webkit-outer-spin-button,.dsw_threshold_input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
.dsw_threshold_input:focus{outline:none;border-bottom-color:var(--dsw-alias-brand-primary);}
.dsw_hint{font-size:10px;color:var(--dsw-alias-label-secondary);line-height:1.5;}
.dsw_err{color:var(--dsw-alias-state-error-primary);font-size:10px;line-height:1.5;word-break:break-all;}
.dsw_warn{font-size:10px;color:var(--dsw-alias-state-warn-primary);line-height:1.5;}
.dsw_center{text-align:center;}
.dsw_inline_warn{display:inline-flex;align-items:center;gap:4px;line-height:1.5;}
.dsw_inline_warn svg{display:block;flex:none;}
.dsw_dock_btns{display:flex;gap:6px;flex:none;margin-top:0;}
.dsw_btn{border:none;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:var(--vk-fs-xs);padding:3px 9px;border-radius:var(--vk-r-sm);font-family:inherit;line-height:1.4;}
.dsw_btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dsw_btn.dsw_primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);}
.dsw_btn.dsw_primary:hover{filter:brightness(1.08);}
.dsw_tooltip{position:absolute;left:12px;right:12px;min-width:220px;z-index:100;background:var(--dsw-specific-sidebar-fill);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--vk-r-md);padding:8px 10px;box-shadow:var(--dsw-shadow-lv2);display:flex;flex-direction:column;gap:4px;}
.dsw_tooltip_title{font-size:var(--vk-fs-xs);font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:2px;}
.dsw_tooltip_row{display:flex;gap:10px;font-size:var(--vk-fs-xs);align-items:baseline;}
.dsw_tooltip_name{color:var(--dsw-alias-label-secondary);min-width:46px;white-space:nowrap;flex:none;}
.dsw_tooltip_tok{flex:1;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dsw_tooltip_amt{width:64px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:600;}
.dsw_rail{display:flex;align-items:center;justify-content:center;padding:4px 0;}
.dsw_ibar{width:22px;height:22px;border-radius:var(--vk-r-md);border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none;padding:0;}
.dsw_ibar:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.dsw_ibar svg{display:block;}
.dsw_dock.dsw_compact{border-top:none;background:transparent;padding:0 2px;width:auto;}
.dsw_dock.dsw_compact .dsw_dock_head{cursor:pointer;}
.dsw_dock.dsw_compact .dsw_collapse{position:absolute;bottom:calc(100% + 6px);left:0;min-width:220px;background:var(--dsw-specific-sidebar-fill);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--vk-r-md);box-shadow:var(--dsw-shadow-lv2);padding:0 10px 8px;z-index:300;}
`;

    function svgIcon(d, size) {
      return h('svg', { viewBox: '0 0 24 24', width: size || 14, height: size || 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, dangerouslySetInnerHTML: { __html: d } });
    }

    function WalletIcon() {
      return svgIcon('<path d="M21 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M16 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/><path d="M3 9h18"/>');
    }
    function RefreshIcon() { return svgIcon('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>', 13); }
    function WarnIcon() { return svgIcon('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>', 11); }
    function ChevronIcon(props) {
      return h('svg', { viewBox: '0 0 24 24', width: 12, height: 12, fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { transform: props.up ? 'rotate(180deg)' : 'none', transition: 'transform .2s ease' }, dangerouslySetInnerHTML: { __html: '<path d="M6 9l6 6 6-6"/>' } });
    }
    function warn(text) {
      return h('span', { className: 'dsw_inline_warn' }, h(WarnIcon), h('span', null, text));
    }

    function WalletDock(props) {
      const compact = props && props.compact === true;
      const wide = props.wide;
      const sessions = props.sessions;
      // 2026-09-30 修：会话列表快照只有 {ids,byId,phase,projectionsBySession}，没有 current。
      // 旧写法恒取 undefined → 请求退化成 /wallet/api/cost（无 session）→ 宿主回 missing-session →
      // 峰谷徽标不渲染、「本会话消耗」一直是 --。现行口径 = byId 里 retainedBy.mainView>0 的那条
      //（与官方 ui-workspace 内部 mainSessionId 同款）。
      const currentSessionId = React.useSyncExternalStore(
        sessions && sessions.list ? (cb) => sessions.list.subscribe(cb) : () => () => {},
        sessions && sessions.list ? () => {
          const snap = sessions.list.getSnapshot();
          const rows = snap && snap.byId ? Object.values(snap.byId) : [];
          for (const row of rows) if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return row.id;
          return undefined;
        } : () => undefined,
        () => undefined
      );
      const [view, setView] = React.useState(null);
      const [cost, setCost] = React.useState(null);
      const [usage, setUsage] = React.useState(null);
      const [thresholdDraft, setThresholdDraft] = React.useState(null);
      const [tip, setTip] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const dockRef = React.useRef(null);
      const labelRef = React.useRef(null);
      const bandRef = React.useRef(null);
      const lowNotifiedRef = React.useRef(false);
      const overNotifiedRef = React.useRef(false);

      React.useLayoutEffect(() => {
        if (labelRef.current && bandRef.current) {
          const h = labelRef.current.offsetHeight;
          if (h > 0) bandRef.current.style.height = h + 'px';
        }
      });

      React.useEffect(() => {
        let alive = true;
        const pollBalance = () => {
          apiGet('/wallet/api/balance').then((v) => { if (alive) setView(v); }, () => { if (alive) setView(null); });
        };
        pollBalance();
        const t1 = setInterval(pollBalance, POLL_MS);
        const onVis = () => { if (document.visibilityState === 'visible') pollBalance(); };
        document.addEventListener('visibilitychange', onVis);
        return () => { alive = false; clearInterval(t1); document.removeEventListener('visibilitychange', onVis); };
      }, []);

      React.useEffect(() => {
        let alive = true;
        const pollCost = () => {
          apiGet(currentSessionId ? '/wallet/api/cost?session=' + encodeURIComponent(currentSessionId) : '/wallet/api/cost')
            .then((c) => { if (alive) setCost(c); }, () => { /* ignore */ });
        };
        setCost(null);
        pollCost();
        const t2 = setInterval(pollCost, COST_POLL_MS);
        return () => { alive = false; clearInterval(t2); };
      }, [currentSessionId]);

      React.useEffect(() => {
        let alive = true;
        const pollUsage = () => {
          apiGet('/wallet/api/usage').then((u) => { if (alive) setUsage(u); }, () => { /* ignore */ });
        };
        pollUsage();
        const t3 = setInterval(pollUsage, POLL_MS);
        return () => { alive = false; clearInterval(t3); };
      }, []);

      React.useEffect(() => {
        const low = !!(view && view.low && view.low.length);
        if (low && !lowNotifiedRef.current) {
          lowNotifiedRef.current = true;
          notify('DeepSeek 余额偏低', view.low.map((l) => l.currency + ' ' + l.total).join(' / ') + '，建议充值');
        }
        if (!low) lowNotifiedRef.current = false;
      }, [view]);

      React.useEffect(() => {
        const cTotal = cost && cost.ok === true && cost.cost !== undefined ? cost.cost : undefined;
        const thr = cost && cost.ok === true && cost.costThreshold !== undefined ? cost.costThreshold : 5;
        const over = cTotal !== undefined && cTotal > thr;
        if (over && !overNotifiedRef.current) {
          overNotifiedRef.current = true;
          notify('DeepSeek 消耗提醒', '当前窗口上下文过长，建议新建对话避免余额浪费');
        }
        if (!over) overNotifiedRef.current = false;
      }, [cost]);

      const refresh = () => { apiGet('/wallet/api/refresh').then((v) => setView(v), () => { /* ignore */ }); };
      const openUrl = (url) => { try { window.open(url, '_blank'); } catch { /* ignore */ } };

      if (!wide) {
        return h('div', { className: 'dsw_rail' },
          h('button', { type: 'button', className: 'dsw_ibar', title: 'DeepSeek 钱包', onClick: () => openUrl(RECHARGE_URL) }, h(WalletIcon, null)),
        );
      }

      const currency = view && (view.currency || (view.balances[0] && view.balances[0].currency)) || 'CNY';
      const total = view && view.total !== undefined ? view.total : undefined;
      const costTotal = cost && cost.ok === true && cost.cost !== undefined ? cost.cost : undefined;
      const threshold = cost && cost.ok === true && cost.costThreshold !== undefined ? cost.costThreshold : 5;
      const overThreshold = costTotal !== undefined && costTotal > threshold;
      const usageReady = usage && usage.ok === true && usage.ready === true;
      const todayCost = usageReady && usage.today ? usage.today.cost : undefined;
      const usageStale = !!(usage && usage.ok === true && usage.officialTodayStale);

      const balanceText = total !== undefined ? ('¥' + fmt(total) + ' ' + currency) : '--';
      const dotCls = view && !view.error && view.available ? 'dsw_dot_ok' : 'dsw_dot';

      const saveThreshold = (val) => {
        const t = Number(val);
        setThresholdDraft(null);
        if (!Number.isFinite(t) || t < 0 || t === threshold) return;
        // 乐观更新：回车/失焦立即反映到界面，POST 异步持久化
        setCost((c) => (c ? { ...c, costThreshold: t } : c));
        fetch('/wallet/api/set-threshold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: currentSessionId, threshold: t }) })
          .then((r) => r.json())
          .then((v) => { if (v && v.ok) { setCost((c) => (c ? { ...c, costThreshold: v.costThreshold } : c)); } })
          .catch(() => {});
      };

      const showTip = (e) => {
        if (!cost || cost.ok !== true || !cost.breakdown) return;
        const r = e.currentTarget.getBoundingClientRect();
        const d = dockRef.current ? dockRef.current.getBoundingClientRect() : { bottom: 0 };
        setTip({ bottom: d.bottom - r.top + 4 });
      };

      const tooltip = tip && cost && cost.ok === true && cost.breakdown ? h('div', { className: 'dsw_tooltip', style: { bottom: tip.bottom + 'px' } },
        h('div', { className: 'dsw_tooltip_title' }, '本会话明细'),
        h('div', { className: 'dsw_tooltip_row' },
          h('span', { className: 'dsw_tooltip_name' }, '输入'),
          h('span', { className: 'dsw_tooltip_tok' }, fmtTokens(cost.uncachedInputTokens) + ' tok'),
          h('span', { className: 'dsw_tooltip_amt' }, '¥' + fmt(cost.breakdown.input)),
        ),
        h('div', { className: 'dsw_tooltip_row' },
          h('span', { className: 'dsw_tooltip_name' }, '缓存命中'),
          h('span', { className: 'dsw_tooltip_tok' }, fmtTokens(cost.cacheReadTokens) + ' tok'),
          h('span', { className: 'dsw_tooltip_amt' }, '¥' + fmt(cost.breakdown.cacheRead)),
        ),
        h('div', { className: 'dsw_tooltip_row' },
          h('span', { className: 'dsw_tooltip_name' }, '输出'),
          h('span', { className: 'dsw_tooltip_tok' }, fmtTokens(cost.outputTokens) + ' tok'),
          h('span', { className: 'dsw_tooltip_amt' }, '¥' + fmt(cost.breakdown.output)),
        ),
      ) : null;

      const body = h('div', { className: 'dsw_dock_body_inner' },
        h('div', { className: 'dsw_row' },
          h('span', { className: 'dsw_row_label' }, '余额'),
          h('span', { className: 'dsw_balance_value' }, balanceText),
        ),
        h('div', { className: 'dsw_row' },
          h('span', { className: 'dsw_row_label', title: usageStale ? '官方账单按小时结算，最近约 10~20 分钟尚未入账；此处按本地实时统计' : undefined }, '今日累计'),
          h('span', { className: 'dsw_row_value' }, todayCost !== undefined ? ('¥' + fmt(todayCost)) : '--'),
        ),
        h('div', { className: 'dsw_row' },
          h('span', { className: 'dsw_row_label' },
            h('span', { ref: labelRef }, '本会话消耗'),
            cost && cost.ok === true && cost.band ? h('span', { ref: bandRef, className: 'dsw_band ' + (cost.band === 'peak' ? 'peak' : cost.band === 'offPeak' ? 'offpeak' : 'base') }, cost.band === 'peak' ? '高峰价' : cost.band === 'offPeak' ? '空闲价' : '基础价') : null,
          ),
          cost && cost.ok === true && cost.breakdown
            ? h('span', { className: 'dsw_row_value', onMouseEnter: showTip, onMouseLeave: () => setTip(null) }, costTotal !== undefined ? ('¥' + fmt(costTotal)) : '--')
            : h('span', { className: 'dsw_row_value' }, costTotal !== undefined ? ('¥' + fmt(costTotal)) : '--'),
        ),
        h('div', { className: 'dsw_row' },
          h('span', { className: 'dsw_row_label' }, '提醒阈值'),
          h('span', { className: 'dsw_threshold_wrap' },
            h('span', { className: 'dsw_threshold_symbol' }, '¥'),
            h('input', {
              className: 'dsw_threshold_input',
              type: 'number', min: 0, step: 0.01,
              value: thresholdDraft !== null ? thresholdDraft : (Number.isFinite(threshold) ? threshold.toFixed(2) : '5.00'),
              onChange: (e) => setThresholdDraft(e.target.value),
              onBlur: (e) => saveThreshold(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur(); },
            }),
          ),
        ),
        !view ? h('div', { className: 'dsw_hint dsw_center' }, '连接中…')
          : view.error ? h('div', { className: 'dsw_err dsw_center' }, warn(view.error))
          : view.available === false ? h('div', { className: 'dsw_warn dsw_center' }, warn('账户不可用'))
          : view.low && view.low.length ? h('div', { className: 'dsw_warn dsw_center', title: '余额偏低，建议充值' }, warn('余额偏低'))
          : overThreshold ? h('div', { className: 'dsw_err dsw_center', title: '当前窗口上下文过长，建议新建对话避免余额浪费' },
              warn('上下文过长 · 建议新建对话'))
          : null,
        h('div', { className: 'dsw_dock_btns' },
          h('button', { type: 'button', className: 'dsw_btn dsw_primary', onClick: () => openUrl(RECHARGE_URL) }, '充值'),
          h('button', { type: 'button', className: 'dsw_btn', onClick: () => openUrl(API_KEYS_URL) }, 'API Key'),
          h('button', { type: 'button', className: 'dsw_btn', onClick: () => openUrl(USAGE_URL) }, '明细'),
        ),
      );

      return h('div', { ref: dockRef, className: 'dsw_dock' + (compact ? ' dsw_compact' : '') },
        compact
          ? h('div', { className: 'dsw_dock_head' },
              h('span', { className: dotCls }),
              h('button', { type: 'button', className: 'dsw_ibar', title: 'DeepSeek 钱包', onClick: () => setOpen(!open), 'aria-label': 'DeepSeek 钱包', 'aria-expanded': open }, h(WalletIcon)),
            )
          : h('div', { className: 'dsw_dock_head' },
              h('span', { className: dotCls }),
              h('span', { className: 'dsw_dock_title', title: 'DeepSeek 钱包', onClick: () => setOpen(!open) }, '钱包'),
              open ? null : h('span', { className: 'dsw_balance_inline' }, balanceText),
              h('button', { type: 'button', className: 'dsw_ibar', title: '立即刷新', onClick: refresh, 'aria-label': '刷新' }, h(RefreshIcon)),
              h('button', { type: 'button', className: 'dsw_ibar', title: open ? '收起' : '展开', onClick: () => setOpen(!open), 'aria-label': open ? '收起' : '展开', 'aria-expanded': open }, h(ChevronIcon, { up: open })),
            ),
        h('div', { className: 'dsw_collapse' + (open ? ' dsw_open' : '') },
          h('div', { className: 'dsw_collapse_inner' }, body),
        ),
        tooltip,
      );
    }

    const inject = ['slots', 'sessions'];
    function apply(ctx) {
      insertStyles(CSS);
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      const sessions = ctx.get('sessions');
      slots.inject('vk.sidebar.footer', () => slots.register(
        { name: 'vk.sidebar.footer', id: 'dsw-wallet', order: 100, label: 'DeepSeek 钱包' },
        (props) => (h(WalletDock, { ...props, sessions })),
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
