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
.dsw-dock{box-sizing:border-box;width:100%;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill);display:flex;flex-direction:column;padding:6px 10px 8px;font-size:11px;color:var(--dsw-alias-label-primary);position:relative;overflow:visible;}
.dsw-dock-head{display:flex;align-items:center;gap:6px;min-height:20px;flex:none;}
.dsw-dock-title{font-weight:600;font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;user-select:none;}
.dsw-balance-inline{font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);flex:none;white-space:nowrap;}
.dsw-collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .25s ease;}
.dsw-collapse.dsw-open{grid-template-rows:1fr;}
.dsw-collapse-inner{overflow:hidden;min-height:0;opacity:0;transition:opacity .18s ease;}
.dsw-collapse.dsw-open .dsw-collapse-inner{opacity:1;}
.dsw-dock-body-inner{display:flex;flex-direction:column;gap:6px;padding-top:6px;}
.dsw-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:none;}
.dsw-dot-ok{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;}
.dsw-balance-value{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);white-space:nowrap;}
.dsw-row{display:flex;align-items:center;justify-content:space-between;gap:8px;line-height:1.3;min-height:16px;}
.dsw-row-label{font-size:10px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:5px;flex:none;}
.dsw-row-value{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsw-band{display:inline-flex;align-items:center;justify-content:center;padding:0 5px;border-radius:999px;font-size:9px;line-height:1.5;font-weight:600;flex:none;white-space:nowrap;box-sizing:border-box;}
.dsw-band.base{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);}
.dsw-band.peak{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 22%,transparent);color:var(--dsw-alias-state-warn-primary);}
.dsw-band.offpeak{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 20%,transparent);color:var(--dsw-alias-state-success-primary);}
.dsw-threshold-wrap{display:inline-flex;align-items:center;gap:3px;}
.dsw-threshold-symbol{color:var(--dsw-alias-label-secondary);font-size:12px;}
.dsw-threshold-input{width:5ch;min-width:5ch;background:transparent;border:none;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:0;padding:1px 2px;font-size:12px;font-family:inherit;text-align:center;font-variant-numeric:tabular-nums;box-sizing:border-box;-moz-appearance:textfield;}
.dsw-threshold-input::-webkit-outer-spin-button,.dsw-threshold-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
.dsw-threshold-input:focus{outline:none;border-bottom-color:var(--dsw-alias-brand-primary);}
.dsw-hint{font-size:10px;color:var(--dsw-alias-label-secondary);line-height:1.5;}
.dsw-err{color:var(--dsw-alias-state-error-primary);font-size:10px;line-height:1.5;word-break:break-all;}
.dsw-warn{font-size:10px;color:var(--dsw-alias-state-warn-primary);line-height:1.5;}
.dsw-center{text-align:center;}
.dsw-inline-warn{display:inline-flex;align-items:center;gap:4px;line-height:1.5;}
.dsw-inline-warn svg{display:block;flex:none;}
.dsw-dock-btns{display:flex;gap:6px;flex:none;margin-top:0;}
.dsw-btn{border:none;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font-size:11px;padding:3px 9px;border-radius:6px;font-family:inherit;line-height:1.4;}
.dsw-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dsw-btn.dsw-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);}
.dsw-btn.dsw-primary:hover{filter:brightness(1.08);}
.dsw-tooltip{position:absolute;left:12px;right:12px;z-index:100;background:var(--dsw-specific-sidebar-fill);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;box-shadow:var(--dsw-shadow-lv2);display:flex;flex-direction:column;gap:4px;}
.dsw-tooltip-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:2px;}
.dsw-tooltip-row{display:flex;gap:10px;font-size:11px;align-items:baseline;}
.dsw-tooltip-name{color:var(--dsw-alias-label-secondary);min-width:46px;white-space:nowrap;flex:none;}
.dsw-tooltip-tok{flex:1;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.dsw-tooltip-amt{width:64px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:600;}
.dsw-rail{display:flex;align-items:center;justify-content:center;padding:4px 0;}
.dsw-ibar{width:22px;height:22px;border-radius:8px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none;padding:0;}
.dsw-ibar:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.dsw-ibar svg{display:block;}
.dsw-dock.dsw-compact{border-top:none;background:transparent;padding:0 2px;width:auto;}
.dsw-dock.dsw-compact .dsw-dock-head{cursor:pointer;}
.dsw-dock.dsw-compact .dsw-collapse{position:absolute;bottom:calc(100% + 6px);left:0;min-width:220px;background:var(--dsw-specific-sidebar-fill);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:var(--dsw-shadow-lv2);padding:0 10px 8px;z-index:300;}
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
      return h('span', { className: 'dsw-inline-warn' }, h(WarnIcon), h('span', null, text));
    }

    function WalletDock(props) {
      const compact = props && props.compact === true;
      const wide = props.wide;
      const sessions = props.sessions;
      const currentSessionId = React.useSyncExternalStore(
        sessions && sessions.list ? (cb) => sessions.list.subscribe(cb) : () => () => {},
        sessions && sessions.list ? () => sessions.list.getSnapshot().current : () => undefined,
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
        return h('div', { className: 'dsw-rail' },
          h('button', { type: 'button', className: 'dsw-ibar', title: 'DeepSeek 钱包', onClick: () => openUrl(RECHARGE_URL) }, h(WalletIcon, null)),
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
      const dotCls = view && !view.error && view.available ? 'dsw-dot-ok' : 'dsw-dot';

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
        const d = dockRef.current ? dockRef.current.getBoundingClientRect() : { top: 0 };
        setTip({ top: r.bottom - d.top + 4 });
      };

      const tooltip = tip && cost && cost.ok === true && cost.breakdown ? h('div', { className: 'dsw-tooltip', style: { top: tip.top + 'px' } },
        h('div', { className: 'dsw-tooltip-title' }, '本会话明细'),
        h('div', { className: 'dsw-tooltip-row' },
          h('span', { className: 'dsw-tooltip-name' }, '输入'),
          h('span', { className: 'dsw-tooltip-tok' }, fmtTokens(cost.uncachedInputTokens) + ' tok'),
          h('span', { className: 'dsw-tooltip-amt' }, '¥' + fmt(cost.breakdown.input)),
        ),
        h('div', { className: 'dsw-tooltip-row' },
          h('span', { className: 'dsw-tooltip-name' }, '缓存命中'),
          h('span', { className: 'dsw-tooltip-tok' }, fmtTokens(cost.cacheReadTokens) + ' tok'),
          h('span', { className: 'dsw-tooltip-amt' }, '¥' + fmt(cost.breakdown.cacheRead)),
        ),
        h('div', { className: 'dsw-tooltip-row' },
          h('span', { className: 'dsw-tooltip-name' }, '输出'),
          h('span', { className: 'dsw-tooltip-tok' }, fmtTokens(cost.outputTokens) + ' tok'),
          h('span', { className: 'dsw-tooltip-amt' }, '¥' + fmt(cost.breakdown.output)),
        ),
      ) : null;

      const body = h('div', { className: 'dsw-dock-body-inner' },
        h('div', { className: 'dsw-row' },
          h('span', { className: 'dsw-row-label' }, '余额'),
          h('span', { className: 'dsw-balance-value' }, balanceText),
        ),
        h('div', { className: 'dsw-row' },
          h('span', { className: 'dsw-row-label', title: usageStale ? '官方账单按小时结算，最近约 10~20 分钟尚未入账；此处按本地实时统计' : undefined }, '今日累计'),
          h('span', { className: 'dsw-row-value' }, todayCost !== undefined ? ('¥' + fmt(todayCost)) : '--'),
        ),
        h('div', { className: 'dsw-row' },
          h('span', { className: 'dsw-row-label' },
            h('span', { ref: labelRef }, '本会话消耗'),
            cost && cost.ok === true && cost.band ? h('span', { ref: bandRef, className: 'dsw-band ' + (cost.band === 'peak' ? 'peak' : cost.band === 'offPeak' ? 'offpeak' : 'base') }, cost.band === 'peak' ? '高峰价' : cost.band === 'offPeak' ? '空闲价' : '基础价') : null,
          ),
          cost && cost.ok === true && cost.breakdown
            ? h('span', { className: 'dsw-row-value', onMouseEnter: showTip, onMouseLeave: () => setTip(null) }, costTotal !== undefined ? ('¥' + fmt(costTotal)) : '--')
            : h('span', { className: 'dsw-row-value' }, costTotal !== undefined ? ('¥' + fmt(costTotal)) : '--'),
        ),
        h('div', { className: 'dsw-row' },
          h('span', { className: 'dsw-row-label' }, '提醒阈值'),
          h('span', { className: 'dsw-threshold-wrap' },
            h('span', { className: 'dsw-threshold-symbol' }, '¥'),
            h('input', {
              className: 'dsw-threshold-input',
              type: 'number', min: 0, step: 0.01,
              value: thresholdDraft !== null ? thresholdDraft : (Number.isFinite(threshold) ? threshold.toFixed(2) : '5.00'),
              onChange: (e) => setThresholdDraft(e.target.value),
              onBlur: (e) => saveThreshold(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur(); },
            }),
          ),
        ),
        !view ? h('div', { className: 'dsw-hint dsw-center' }, '连接中…')
          : view.error ? h('div', { className: 'dsw-err dsw-center' }, warn(view.error))
          : view.available === false ? h('div', { className: 'dsw-warn dsw-center' }, warn('账户不可用'))
          : view.low && view.low.length ? h('div', { className: 'dsw-warn dsw-center', title: '余额偏低，建议充值' }, warn('余额偏低'))
          : overThreshold ? h('div', { className: 'dsw-err dsw-center', title: '当前窗口上下文过长，建议新建对话避免余额浪费' },
              warn('上下文过长 · 建议新建对话'))
          : null,
        h('div', { className: 'dsw-dock-btns' },
          h('button', { type: 'button', className: 'dsw-btn dsw-primary', onClick: () => openUrl(RECHARGE_URL) }, '充值'),
          h('button', { type: 'button', className: 'dsw-btn', onClick: () => openUrl(API_KEYS_URL) }, 'API Key'),
          h('button', { type: 'button', className: 'dsw-btn', onClick: () => openUrl(USAGE_URL) }, '明细'),
        ),
      );

      return h('div', { ref: dockRef, className: 'dsw-dock' + (compact ? ' dsw-compact' : '') },
        compact
          ? h('div', { className: 'dsw-dock-head' },
              h('span', { className: dotCls }),
              h('button', { type: 'button', className: 'dsw-ibar', title: 'DeepSeek 钱包', onClick: () => setOpen(!open), 'aria-label': 'DeepSeek 钱包', 'aria-expanded': open }, h(WalletIcon)),
            )
          : h('div', { className: 'dsw-dock-head' },
              h('span', { className: dotCls }),
              h('span', { className: 'dsw-dock-title', title: 'DeepSeek 钱包', onClick: () => setOpen(!open) }, '钱包'),
              open ? null : h('span', { className: 'dsw-balance-inline' }, balanceText),
              h('button', { type: 'button', className: 'dsw-ibar', title: '立即刷新', onClick: refresh, 'aria-label': '刷新' }, h(RefreshIcon)),
              h('button', { type: 'button', className: 'dsw-ibar', title: open ? '收起' : '展开', onClick: () => setOpen(!open), 'aria-label': open ? '收起' : '展开', 'aria-expanded': open }, h(ChevronIcon, { up: open })),
            ),
        h('div', { className: 'dsw-collapse' + (open ? ' dsw-open' : '') },
          h('div', { className: 'dsw-collapse-inner' }, body),
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
