window.__ModuleLoader__.load({
	id: "dsh-balance-card",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const CARD_SELECTOR = "[data-dsh-balance-card]";
		const POLL_MS = 60 * 1000;

		const CSS = `
			.dbc-fallback{display:flex;align-items:center;gap:8px;width:calc(100% - 16px);margin:4px 8px;padding:7px 10px;border:1px solid rgba(128,128,128,.22);border-radius:10px;background:rgba(128,128,128,.08);color:inherit;font:inherit;font-size:12px;cursor:pointer;text-align:left}
			.dbc-cloned{display:flex;align-items:center;gap:8px;background:transparent;border:none;width:100%;cursor:pointer;color:inherit;font:inherit;text-align:left}
			.dbc-value{margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums;opacity:.9}
			.dbc-value.dbc-err{opacity:.55;font-weight:400}
			.dbc-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45))}
			.dbc-modal{width:min(560px,92vw);max-height:84vh;overflow:auto;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fff));box-shadow:0 18px 60px rgba(0,0,0,.25);padding:20px 22px;font-size:13px;line-height:1.6}
			.dbc-modal h2{margin:0 0 12px;font-size:15px;display:flex;align-items:center;gap:8px}
			.dbc-modal h3{margin:18px 0 8px;font-size:13px;opacity:.85}
			.dbc-close{margin-left:auto;border:none;background:transparent;color:inherit;font-size:16px;cursor:pointer;opacity:.7;padding:2px 6px;border-radius:6px}
			.dbc-close:hover{opacity:1;background:rgba(128,128,128,.15)}
			.dbc-row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.15))}
			.dbc-row:last-child{border-bottom:none}
			.dbc-row .k{opacity:.72}
			.dbc-row .v{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
			.dbc-total .v{color:#3fb950}
			.dbc-note{margin-top:10px;font-size:11px;opacity:.55}
			.dbc-refresh{margin-top:14px;padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1));color:inherit;cursor:pointer;font:inherit;font-size:12px}
			.dbc-refresh:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.2))}
			.dbc-refresh:disabled{opacity:.5;cursor:wait}
			.dbc-updated{margin-top:8px;font-size:11px;opacity:.5}
			.dbc-sessionlist{max-height:230px;overflow:auto}
			.dbc-session .k{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
			.dbc-session .t{opacity:.6;font-size:11px;white-space:nowrap;margin-right:10px}
			[data-dsh-frame]{column-gap:0 !important}
			body :has(> [class*="sidebarCol"]){column-gap:0 !important}
			[class*="splitHandle"]{width:4px !important}
			[class*="explorer-handle"]::after,[class*="preview-handle"]::after{display:none !important}
		`;

		function fmtMoney(n) {
			if (typeof n !== "number" || Number.isNaN(n)) return "--";
			return "\u00a5" + n.toFixed(2);
		}

		function fmtTokens(n) {
			if (typeof n !== "number" || Number.isNaN(n)) return "--";
			if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
			if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
			return String(n);
		}

		function fmtTime(ts) {
			if (!ts) return "--";
			const d = new Date(ts);
			const pad = (x) => String(x).padStart(2, "0");
			return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		}

		function themeTextColor() {
			const host = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
			if (host === null) return "";
			return getComputedStyle(host).color;
		}

		function injectStyles() {
			if (document.querySelector("style[data-dsh-balance-card]") !== null) return;
			const el = document.createElement("style");
			el.setAttribute("data-dsh-balance-card", "");
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		async function getData(force) {
			const res = await fetch(force ? "/balance-card/refresh" : "/balance-card/data", { cache: "no-store" });
			if (!res.ok) throw new Error("http-" + res.status);
			return res.json();
		}

				function esc(s) {
			return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
		}

		function renderModal(data) {
			const bal = data.balance ?? {};
			const info = Array.isArray(bal.balance_infos) ? bal.balance_infos[0] : void 0;
			const usage = data.usage ?? {};
			const totals = usage.totals ?? {};
			const cost = data.cost ?? {};
			const rates = cost.rates ?? {};

			const row = (k, v, cls) => `<div class="dbc-row ${cls ?? ""}"><span class="k">${k}</span><span class="v">${v}</span></div>`;

			let balanceHtml;
			if (bal.error !== void 0) {
				balanceHtml = row("获取失败", bal.error === "missing-api-key" ? "未找到 DEEPSEEK_API_KEY" : String(bal.error));
			} else if (info === void 0) {
				balanceHtml = row("余额", "--");
			} else {
				balanceHtml =
					row("总余额", fmtMoney(Number(info.total_balance))) +
					row("充值余额", fmtMoney(Number(info.topped_up_balance))) +
					row("赠送余额", fmtMoney(Number(info.granted_balance)));
			}

			const usageHtml =
				row("输入（缓存未命中）", fmtTokens(Number(totals.uncachedInputTokens ?? 0))) +
				row("输入（缓存命中）", fmtTokens(Number(totals.cacheReadTokens ?? 0))) +
				row("输出", fmtTokens(Number(totals.outputTokens ?? 0))) +
				row("会话 / 轮次", `${usage.sessionCount ?? usage.sessions ?? 0} / ${usage.turns ?? 0}`);

			const costHtml =
				row(`输入未命中（${rates.miss ?? "--"} 元/M）`, fmtMoney(cost.costMiss)) +
				row(`缓存命中（${rates.hit ?? "--"} 元/M）`, fmtMoney(cost.costCache)) +
				row(`输出（${rates.out ?? "--"} 元/M）`, fmtMoney(cost.costOut)) +
				row("预估总费用", fmtMoney(cost.total), "dbc-total");

			const sessionsHtml = (data.sessions ?? []).slice(0, 20).map((s) =>
				`<div class="dbc-row dbc-session"><span class="k">${esc(s.title)}</span><span class="t">${fmtTokens(s.uncachedInputTokens + s.cacheReadTokens)} in · ${fmtTokens(s.outputTokens)} out</span><span class="v">${fmtMoney(s.cost)}</span></div>`
			).join("");

			return `
				<h2>余额与用量<button class="dbc-close" type="button" aria-label="关闭">✕</button></h2>
				<h3>账户余额（DeepSeek 官方）</h3>${balanceHtml}
				<h3>Token 用量（本地会话统计）</h3>${usageHtml}
				<h3>费用估算 · ${cost.model ?? ""}${cost.peak ? " · 高峰价" : ""}</h3>${costHtml}
				<h3>按任务明细 · 按估算花费排序</h3><div class="dbc-sessionlist">${sessionsHtml}</div>
				<div class="dbc-note">定价：${cost.deckLabel ?? "--"}；费用按 ${cost.model ?? "--"} 官方价估算，混合模型会话仅供参考。</div>
				<button class="dbc-refresh" type="button">刷新余额</button>
				<div class="dbc-updated">更新于 ${fmtTime(data.generatedAt)}</div>
			`;
		}

		function openModal() {
			if (document.querySelector(".dbc-overlay") !== null) return;
			const overlay = document.createElement("div");
			overlay.className = "dbc-overlay";
			const modal = document.createElement("div");
			modal.className = "dbc-modal";
			modal.textContent = "加载中…";
			const textColor = themeTextColor();
			if (textColor !== "") modal.style.color = textColor;
			overlay.appendChild(modal);
			document.body.appendChild(overlay);

			const close = () => overlay.remove();
			overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

			const paint = (data) => {
				modal.innerHTML = renderModal(data);
				modal.querySelector(".dbc-close")?.addEventListener("click", close);
				modal.querySelector(".dbc-refresh")?.addEventListener("click", async (e) => {
					const btn = e.currentTarget;
					btn.disabled = true;
					btn.textContent = "刷新中…";
					try {
						paint(await getData(true));
					} catch (err) {
						btn.disabled = false;
						btn.textContent = "刷新失败，重试";
					}
				});
			};

			getData(false).then(paint).catch((err) => {
				modal.textContent = "加载失败：" + String(err?.message ?? err);
				const btn = document.createElement("button");
				btn.className = "dbc-refresh";
				btn.textContent = "关闭";
				btn.addEventListener("click", close);
				modal.appendChild(btn);
			});
		}

		const ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9.5" rx="2"/><path d="M1.5 6.5h13"/><circle cx="11.5" cy="9.8" r="1" fill="currentColor" stroke="none"/></svg>`;

		function sidebarRoot() {
			const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
			if (column === null) return void 0;
			const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
			return logoOwner ?? column.firstElementChild ?? void 0;
		}

		function settingsAnchor(root) {
			for (const el of root.querySelectorAll("button, [role=\"button\"], a")) {
				const text = `${el.getAttribute("aria-label") ?? ""} ${el.title ?? ""} ${el.className ?? ""} ${el.textContent ?? ""}`;
				if (/setting|设置/.test(text)) return el;
			}
			return null;
		}

		function placeCard(root, card) {
			const anchor = settingsAnchor(root);
			let target = null;
			if (anchor !== null) {
				let node = anchor;
				while (node.parentElement !== null && node.parentElement !== root) node = node.parentElement;
				target = node.parentElement === root ? node : anchor;
				const rowEl = anchor.tagName === "BUTTON" || anchor.getAttribute("role") === "button"
					? anchor
					: anchor.querySelector("button, [role=\"button\"]");
				const rowClass = (rowEl ?? anchor).className;
				if (typeof rowClass === "string" && rowClass.trim() !== "") {
					card.className = `${rowClass} dbc-cloned`;
				} else {
					card.className = "dbc-fallback";
				}
				root.insertBefore(card, target);
				return true;
			}
			card.className = "dbc-fallback";
			root.appendChild(card);
			return true;
		}

		function apply() {
			if (typeof document === "undefined") return;
			if (document.querySelector(CARD_SELECTOR) !== null) return;
			injectStyles();

			const card = document.createElement("button");
			card.type = "button";
			card.setAttribute("data-dsh-balance-card", "");
			card.setAttribute("aria-label", "余额与用量");
			card.innerHTML = `${ICON}<span class="dbc-label">余额</span><span class="dbc-value">…</span>`;
			card.addEventListener("click", openModal);

			const valueEl = card.querySelector(".dbc-value");
			let disposed = false;

			const refreshValue = async () => {
				if (disposed) return;
				try {
					const data = await getData(false);
					if (disposed) return;
					const bal = data.balance ?? {};
					if (bal.error !== void 0) {
						valueEl.textContent = "不可用";
						valueEl.classList.add("dbc-err");
						return;
					}
					const info = Array.isArray(bal.balance_infos) ? bal.balance_infos[0] : void 0;
					valueEl.classList.remove("dbc-err");
					valueEl.textContent = info === void 0 ? "--" : fmtMoney(Number(info.total_balance));
				} catch {
					valueEl.textContent = "离线";
					valueEl.classList.add("dbc-err");
				}
			};

			let root = void 0;
			let placed = false;
			const tryPlace = () => {
				if (disposed) return;
				if (root !== void 0 && !root.isConnected) {
					rootObserver.disconnect();
					root = void 0;
					placed = false;
				}
				if (placed) {
					if (document.body.contains(card)) return;
					rootObserver.disconnect();
					root = void 0;
					placed = false;
				}
				root ??= sidebarRoot();
				if (root === void 0) return;
				placed = placeCard(root, card);
				if (placed) rootObserver.observe(root, { childList: true, subtree: true });
			};

			const waitObserver = new MutationObserver(() => tryPlace());
			waitObserver.observe(document.body, { childList: true, subtree: true });
			const rootObserver = new MutationObserver(() => {
				if (root === void 0 || !root.isConnected || !root.contains(card)) {
					placed = false;
					tryPlace();
				}
			});

			tryPlace();
			refreshValue();
			const timer = setInterval(refreshValue, POLL_MS);

			return () => {
				disposed = true;
				clearInterval(timer);
				waitObserver.disconnect();
				rootObserver.disconnect();
				card.remove();
			};
		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	}
});



