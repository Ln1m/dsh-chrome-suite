// dsh-restart-button —— Client half
//
// Registers a "Restart DSH" button into `conversation.session.header.utilities`.
// Two-click confirm, then POST to /dsh-restart/restart, which restarts THIS
// instance (the host half resolves its own port).
//
// 2026-09-11 fix: the old implementation set `busy = true` and never reset it,
// so one click left the button permanently disabled until the page was
// reloaded. This version owns a full recovery state machine:
//   idle -> armed (4s auto-reset) -> busy -> idle | timeout
// while busy it probes the backend every 1.2s; recovery requires having seen a
// real outage first (the dying process still answers for ~0.8s) followed by two
// consecutive successes, with a 60s deadline as the final way out.
//
// The custom layout (@anoslide/dsh-client-vscode-layout) hides `.drb-btn` and
// renders its own restart button in the left tab bar; both halves share the same
// host route and the same semantics. The model never triggers either one.

window.__ModuleLoader__.load({
  id: 'dsh-restart-button',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    const h = React.createElement;

    const ARM_TIMEOUT_MS = 4000;
    const PROBE_INTERVAL_MS = 1200;
    const PROBE_DEADLINE_MS = 60000;

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

    // 胶囊按钮：对齐官方 Session log 按钮（border-radius 18px / height 32px），
    // 用主题 token 自动适配深/浅色。
    const CSS = `
.drb-wrap{display:inline-flex;align-items:center;gap:6px;flex:none;min-width:0;}
.drb-btn{border:1px solid var(--dsw-alias-border-l2);height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:0 0;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:6px 12px;font-size:13px;font-weight:400;line-height:20px;display:inline-flex;flex:none;white-space:nowrap;}
.drb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.drb-btn:disabled{cursor:default;color:var(--dsw-alias-label-dimmed);}
.drb-btn.drb-arm{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}
.drb-btn.drb-arm:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);}
.drb-note{font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:22em;color:var(--dsw-alias-label-secondary);}
.drb-note.drb-warn{color:var(--dsw-alias-state-warn-primary,#e0a63c);}
.drb-note.drb-err{color:var(--dsw-alias-state-error-primary);}
`;

    /** One cheap liveness probe that every dsh instance answers: the index page. */
    async function backendAlive() {
      try {
        const res = await fetch('/', { method: 'GET', cache: 'no-store', redirect: 'manual' });
        return res.ok === true || res.type === 'opaqueredirect' || (res.status >= 200 && res.status < 400);
      } catch {
        return false;
      }
    }

    function RestartButton() {
      const [phase, setPhase] = React.useState('idle'); // idle | armed | busy | timeout
      const [note, setNote] = React.useState(null);
      const [noteKind, setNoteKind] = React.useState('plain');
      const [info, setInfo] = React.useState(null);
      const failuresRef = React.useRef(0);
      const streakRef = React.useRef(0);
      const timerRef = React.useRef(null);
      const deadlineRef = React.useRef(0);

      const stopPolling = React.useCallback(() => {
        if (timerRef.current !== null) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }, []);

      React.useEffect(() => () => stopPolling(), [stopPolling]);

      // Instance identity (port / argv) for the tooltip; absence is harmless.
      React.useEffect(() => {
        let alive = true;
        fetch('/dsh-restart/status', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => { if (alive && data && data.ok) setInfo(data); })
          .catch(() => { /* older host half: no status route */ });
        return () => { alive = false; };
      }, []);

      React.useEffect(() => {
        if (phase !== 'armed') return undefined;
        const t = setTimeout(() => { setPhase((cur) => (cur === 'armed' ? 'idle' : cur)); setNote(null); }, ARM_TIMEOUT_MS);
        return () => clearTimeout(t);
      }, [phase]);

      const poll = React.useCallback(async () => {
        const ok = await backendAlive();
        if (!ok) {
          failuresRef.current += 1;
          streakRef.current = 0;
          setNoteKind('warn');
          setNote('后端已停止应答，重启中…');
          return;
        }
        if (failuresRef.current > 0) {
          streakRef.current += 1;
          if (streakRef.current >= 2) {
            stopPolling();
            failuresRef.current = 0;
            streakRef.current = 0;
            setPhase('idle');
            setNoteKind('plain');
            setNote('后端已重新连接，按钮已恢复');
            return;
          }
          setNoteKind('warn');
          setNote('后端正在恢复…');
          return;
        }
        setNoteKind('plain');
        setNote('已请求重启，等待后端断开…');
      }, [stopPolling]);

      const onClick = React.useCallback(async () => {
        if (phase === 'busy') return;
        if (phase !== 'armed') {
          setPhase('armed');
          setNoteKind('plain');
          setNote('再次点击「确认」以重启后端');
          return;
        }
        setPhase('busy');
        setNoteKind('plain');
        setNote('已请求重启，等待后端断开…');
        failuresRef.current = 0;
        streakRef.current = 0;
        deadlineRef.current = Date.now() + PROBE_DEADLINE_MS;
        stopPolling();
        timerRef.current = setInterval(() => {
          if (Date.now() > deadlineRef.current) {
            stopPolling();
            setPhase('timeout');
            setNoteKind('err');
            setNote('重启未确认（60 秒），按钮已恢复可点；若页面异常请手动刷新');
            return;
          }
          poll();
        }, PROBE_INTERVAL_MS);
        try {
          await fetch('/dsh-restart/restart', { method: 'POST', cache: 'no-store' });
        } catch {
          setNoteKind('warn');
          setNote('重启请求已发出（连接在应答前中断属正常）');
        }
        poll();
      }, [phase, poll, stopPolling]);

      // busy 不改文字（与自研布局那颗按钮同一套文案）：官方 ConnectionIndicator 已经提示在重启，
      // 忙态靠禁用变暗（.drb-btn:disabled）区分，避免按钮面在窄栏里突然变宽。
      const label = phase === 'armed' ? '确认' : phase === 'timeout' ? '重启超时' : '重启 DSH';
      const portText = info && info.port ? '（端口 ' + info.port + '）' : '';
      const title = phase === 'busy'
        ? '重启中' + portText + '：按钮会在后端恢复后自动复位'
        : phase === 'timeout'
          ? '上次重启未确认；点一下重新开始'
          : '重启 DSH 后端' + portText + '（两击确认，将中断当前对话）';

      return h('span', { className: 'drb-wrap' },
        h('button', {
          type: 'button',
          className: 'drb-btn' + (phase === 'armed' ? ' drb-arm' : ''),
          disabled: phase === 'busy',
          onClick,
          title,
        }, h('span', null, label)),
        note ? h('span', { className: 'drb-note' + (noteKind === 'warn' ? ' drb-warn' : noteKind === 'err' ? ' drb-err' : ''), title: note }, note) : null,
      );
    }

    const inject = ['slots'];
    function apply(ctx) {
      insertStyles(CSS);
      const slots = ctx.get('slots');
      if (slots === undefined) {
        console.warn('[dsh-restart-button] slots service unavailable');
        return;
      }
      slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'dsh-restart', order: 1, label: '重启 DSH' },
        () => h(RestartButton),
      ));
      console.log('[dsh-restart-button] client applied');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
