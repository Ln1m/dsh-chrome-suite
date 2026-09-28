// dsh-vk-terminal — 会话头右上角的 DSH 重启按钮（两击确认 + 探针复位）。
// 合并了旧的两个重启入口：语义与恢复判据照搬 dsh-restart-button 的客户端半端，
// host 路由仍是 /dsh-restart/restart（重启**本实例**，不是硬编码 3080）。
window.__ModuleLoader__.load({
	id: 'dsh-vk-terminal',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const react = require('react');
		const contract = require('dsh-vk-contract');
		const h = react.createElement;

		const VK = contract.VK;
		const vkCard = contract.vkCard;

		const ICON_REFRESH = '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>';
		function VIcon({ name, size = 14 }) {
			if (name !== 'refresh') return null;
			return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { flex: 'none', display: 'block' }, dangerouslySetInnerHTML: { __html: ICON_REFRESH } });
		}

		const CSS = `
:root,body{--vk-accent:var(--dsw-alias-accent,var(--dsw-alias-state-business-primary))}
.vk_restartBtn{appearance:none;border:none;background:none;cursor:pointer;width:28px;height:28px;border-radius:7px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;transition:background-color .12s,color .12s,transform .08s}
.vk_restartBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.vk_restartBtn:active{transform:scale(.93)}
.vk_restartBtn:disabled{opacity:.55;cursor:default}
/* armed 态（两击确认的第一击）。必须**压过上面的 :hover**：鼠标点完还停在按钮上，
   .vk_restartBtn:hover 是 (0,2,0)，比单类的 .vk_restartArm (0,1,0) 高，
   旧的写法在悬停期间完全不生效 —— 界面上就是"点一次不会变红"、看不到任何待确认反馈（2026-09-28 实测）。
   这里用双类选择器（同为 0,2,0 但排在 :hover 之后）并连 :hover 一起写死。 */
.vk_restartBtn.vk_restartArm,
.vk_restartBtn.vk_restartArm:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
`;
		(function injectCss() {
			if (typeof document === 'undefined') return;
			const plugin = 'dsh-vk-terminal';
			for (const old of document.querySelectorAll('style[data-plugin="' + plugin + '"]')) { try { old.remove(); } catch { /* ignore */ } }
			const tag = document.createElement('style');
			tag.dataset.plugin = plugin;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		})();

		const PROBE_INTERVAL_MS = 1200;
		const PROBE_DEADLINE_MS = 60000;
		/** 每个实例都会应答的最便宜活性探针：首页本身。 */
		async function vkBackendAlive() {
			try {
				const res = await fetch('/', { method: 'GET', cache: 'no-store', redirect: 'manual' });
				return res.ok === true || res.type === 'opaqueredirect' || (res.status >= 200 && res.status < 400);
			} catch {
				return false;
			}
		}

		/** 按钮外观由 (阶段, 忙) 纯函数决定，避免渲染期出现未定义文案。 */
		function restartButtonView(phase, busy) {
			const disabled = phase === 'busy' || busy === true;
			const label = phase === 'armed' ? '确认' : '⟳ 重启';
			const title = phase === 'armed'
				? '再次点击确认重启（将中断当前对话）'
				: phase === 'busy' ? '重启中：按钮会在后端恢复后自动恢复可点' : '重启 DSH 后端（两击确认）';
			return { disabled, label, title, armed: phase === 'armed' };
		}

		function VKRestartButton() {
			const [phase, setPhase] = react.useState('idle');
			const [note, setNote] = react.useState(null);
			const failures = react.useRef(0);
			const streak = react.useRef(0);
			const timer = react.useRef(null);
			const deadline = react.useRef(0);

			const stopPolling = react.useCallback(() => {
				if (timer.current !== null) { clearInterval(timer.current); timer.current = null; }
			}, []);
			react.useEffect(() => () => stopPolling(), [stopPolling]);
			// armed 态 4 秒没确认就自己退回 idle —— 两击确认不能挂着一个永久待确认的按钮。
			react.useEffect(() => {
				if (phase !== 'armed') return void 0;
				const t = setTimeout(() => { setPhase((cur) => (cur === 'armed' ? 'idle' : cur)); setNote(null); }, 4000);
				return () => clearTimeout(t);
			}, [phase]);

			const poll = react.useCallback(async () => {
				const ok = await vkBackendAlive();
				if (!ok) {
					failures.current += 1;
					streak.current = 0;
					setNote('后端已停止应答，重启中…');
					return;
				}
				if (failures.current > 0) {
					// 旧进程在垂死窗口内仍会应答，所以「见过失败 + 连续 2 次成功」才算回来。
					streak.current += 1;
					if (streak.current >= 2) {
						stopPolling();
						failures.current = 0;
						streak.current = 0;
						setPhase('idle');
						setNote(null);
						return;
					}
					setNote('后端正在恢复…');
					return;
				}
				setNote('已请求重启，等待后端断开…');
			}, [stopPolling]);

			const onClick = react.useCallback(async () => {
				if (phase === 'busy') return;
				if (phase !== 'armed') {
					setPhase('armed');
					setNote('再次点击「确认」以重启后端');
					return;
				}
				setPhase('busy');
				setNote('已请求重启，等待后端断开…');
				failures.current = 0;
				streak.current = 0;
				deadline.current = Date.now() + PROBE_DEADLINE_MS;
				stopPolling();
				timer.current = setInterval(() => {
					if (Date.now() > deadline.current) {
						stopPolling();
						setPhase('timeout');
						setNote('重启未确认（60 秒）；按钮已恢复可点，页面异常时可整页重载');
						return;
					}
					poll();
				}, PROBE_INTERVAL_MS);
				try {
					await fetch('/dsh-restart/restart', { method: 'POST', cache: 'no-store' });
				} catch {
					setNote('重启请求已发出（连接在应答前中断属正常）');
				}
				poll();
			}, [phase, poll, stopPolling]);

			const view = restartButtonView(phase, false);
			return h('button', {
				type: 'button',
				className: 'vk_restartBtn' + (view.armed ? ' vk_restartArm' : ''),
				disabled: view.disabled,
				title: note === null ? view.title : view.title + ' · ' + note,
				'aria-label': '重启 DSH 后端',
				'data-vk-restart': phase,
				onClick
			}, h(VIcon, { name: 'refresh', size: 15 }));
		}

		function apply(ctx) {
			vkCard(ctx, { slot: VK.session.headerRight, id: 'restart', order: 10, component: VKRestartButton });
		}

		exports.apply = apply;
		exports.inject = ['slots'];
		exports.restartButtonView = restartButtonView;
		return module.exports;
	}
});
