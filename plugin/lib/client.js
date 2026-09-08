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
			.dbc-cloned{cursor:pointer}
			/* Bottom stack via flex order — zero DOM moving, stable from the very first paint. */
			[data-dsh-taskboard-entry]{order:98 !important;height:34px !important;color:var(--dsw-alias-label-primary) !important;border-radius:12px !important;margin:4px -4px !important;padding:6px 2px 6px 10px !important;font-size:14px !important;line-height:22px !important;width:calc(100% + 8px) !important;box-sizing:border-box !important}
			button[data-dsh-balance-card]{order:99 !important}
			[class*="footArea"]{order:100 !important}
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
			.dbc-statgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:4px 0 2px}
			.dbc-stat{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:10px;padding:8px 10px}
			.dbc-stat .h{font-size:11px;opacity:.6}
			.dbc-stat .n{font-size:14px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}
			.dbc-stat .c{font-size:11px;opacity:.7;margin-top:2px}
			.dbc-heat{margin-top:8px}
			.dbc-account{background:linear-gradient(135deg,rgba(59,130,246,.18),rgba(99,102,241,.10));border:1px solid rgba(59,130,246,.30);border-radius:12px;padding:12px 14px;margin:2px 0 4px}
			.dbc-account-err{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2))}
			.dbc-badge-off{color:#d97706;background:rgba(217,119,6,.12)}
			.dbc-select{margin:2px 0 6px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10));color:inherit;font:inherit;font-size:12px}
			.dbc-provname{font-size:12px;opacity:.8;margin:2px 0 6px}
			.dbc-price{width:100%;border-collapse:collapse;margin-top:6px;font-size:12px}
			.dbc-price th{font-size:11px;opacity:.55;font-weight:500;text-align:left;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25))}
			.dbc-price td{padding:5px 8px;border-bottom:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.14));font-variant-numeric:tabular-nums}
			.dbc-price-me{font-weight:600}
			.dbc-price-total td{border-bottom:none;font-weight:700}
			.dbc-price-total td:last-child{color:#3fb950}
			.dbc-models{margin-top:8px;display:flex;flex-direction:column;gap:4px}
			.dbc-model{display:grid;grid-template-columns:64px 1fr auto;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:10px;padding:6px 12px;font-size:12px}
			.dbc-model-name{font-weight:600}
			.dbc-model-tok{opacity:.65;font-variant-numeric:tabular-nums}
			.dbc-model b{font-variant-numeric:tabular-nums}
			.dbc-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
			.dbc-chip{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));border-radius:999px;padding:3px 11px;font-size:11px;display:flex;gap:6px;align-items:center}
			.dbc-chip span{opacity:.6}
			.dbc-chip b{font-variant-numeric:tabular-nums}
			.dbc-chip-hot{border-color:rgba(34,197,94,.45);background:rgba(34,197,94,.10)}
			.dbc-acct-head{display:flex;justify-content:space-between;align-items:center}
			.dbc-acct-id{display:flex;gap:10px;align-items:center}
			.dbc-logo{width:34px;height:34px;border-radius:50%;background:rgba(59,130,246,.12);color:#3b82f6;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:13px;flex:none}
			.dbc-name{font-weight:600}
			.dbc-sub{font-size:11px;opacity:.6}
			.dbc-badge{font-size:11px;color:#16a34a;background:rgba(22,163,74,.12);border-radius:999px;padding:2px 9px;flex:none}
			.dbc-amount{font-size:24px;font-weight:700;margin-top:8px;font-variant-numeric:tabular-nums}
			.dbc-acct-line{font-size:11px;opacity:.6;margin-top:2px}
			.dbc-stat .n{font-size:15px}
			/* ZCode 风格 Token 活动热力图：5 档离散色阶、方形格子带边框、悬停放大 */
			.dbc-usage-heat{margin-top:8px}
			.dbc-heat-summary{font-size:11px;opacity:.6;margin-bottom:6px}
			.dbc-heat-months{display:grid;grid-auto-flow:column;grid-auto-columns:16px;gap:4px;font-size:11px;opacity:.6;height:15px;margin:0 0 3px 20px}
			.dbc-heat-months span{white-space:nowrap;justify-self:start}
			.dbc-heat-body{display:flex;gap:4px;align-items:flex-start}
			.dbc-heat-wk{display:grid;grid-template-rows:repeat(7,16px);gap:4px;font-size:9px;opacity:.45;width:16px}
			.dbc-heat-wk span{display:flex;align-items:center;line-height:1}
			/* Codex/GitHub 式固定 16px 密集小格子：一列一周、一行一星期，左对齐不拉伸 */
			.dbc-heat-grid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,16px);grid-auto-columns:16px;gap:4px}
			.dbc-heat-cell{width:16px;height:16px;border-radius:4px;border:1px solid transparent;transition:transform .12s,border-color .12s;cursor:default}
			.dbc-heat-cell:hover{transform:scale(1.18);border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.45));position:relative;z-index:1}
			/* 空白格用固定中性灰：主题的 bg-layer-2 与弹窗背景(layer-3)几乎同色，格子会隐形 */
			.dbc-hl-0{background:rgba(128,128,128,.16)}
			.dbc-hl-1{background:rgba(59,130,246,.30)}
			.dbc-hl-2{background:rgba(59,130,246,.55)}
			.dbc-hl-3{background:rgba(59,130,246,.80)}
			.dbc-hl-4{background:#3b82f6}
			.dbc-heat-legend{display:flex;gap:4px;align-items:center;justify-content:flex-end;font-size:10px;opacity:.7;margin-top:8px}
			.dbc-heat-legend i{width:12px;height:12px;border-radius:3px;display:inline-block}
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

		/** Current provider from the model-select button's React fiber (read-only walk). */
		function readCurrentProviderSafe() {
			try {
				const btn = document.querySelector('button[aria-label^="选择模型"]');
				if (btn === null) return null;
				const fiberKey = Object.keys(btn).find((k) => k.startsWith('__reactFiber$'));
				if (fiberKey === undefined) return null;
				let fiber = btn[fiberKey];
				for (let depth = 0; fiber !== null && depth < 60; depth++) {
					let hook = fiber.memoizedState;
					for (let hop = 0; hook != null && hop < 20; hop++) {
						const ms = hook.memoizedState;
						if (ms !== null && typeof ms === "object" && !Array.isArray(ms)
							&& ms.current !== null && typeof ms.current === "object"
							&& typeof ms.current.provider === "string"
							&& typeof ms.current.model === "string"
							&& Array.isArray(ms.groups)) {
							return ms.current.provider;
						}
						hook = hook.next;
					}
					fiber = fiber.return;
				}
			} catch { }
			return null;
		}
		async function getData(force) {
			const res = await fetch(force ? "/balance-card/refresh" : "/balance-card/data", { cache: "no-store" });
			if (!res.ok) throw new Error("http-" + res.status);
			return res.json();
		}

				function esc(s) {
			return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
		}

		function renderProviderCard(p) {
			if (p === void 0 || p === null) return '<div class="dbc-row"><span class="k">余额</span><span class="v">--</span></div>';
			const err = p.error !== void 0
				? (p.error === "missing-api-key" ? "未配置密钥（.credentials.yaml）" : p.error === "unsupported-balance-endpoint" ? "该供应商暂不支持余额查询" : String(p.error))
				: "";
			const cur = p.currency === "USD" ? "$" : "\u00a5";
			return `
				<div class="dbc-account${err !== "" ? " dbc-account-err" : ""}">
					<div class="dbc-acct-head">
						<div class="dbc-acct-id">
							<div class="dbc-logo">${esc(String(p.displayName ?? "?").slice(0, 2).toUpperCase())}</div>
							<div><div class="dbc-name">${esc(p.displayName ?? p.id)}</div><div class="dbc-sub">API 余额</div></div>
						</div>
						<span class="dbc-badge${err !== "" ? " dbc-badge-off" : ""}">${err !== "" ? "离线" : "实时"}</span>
					</div>
					<div class="dbc-amount">${err !== "" ? "--" : cur + Number(p.available ?? 0).toFixed(2)}</div>
					<div class="dbc-acct-line">${err !== "" ? esc(err) : `充值 ${cur}${Number(p.charged ?? 0).toFixed(2)} · 赠送 ${cur}${Number(p.granted ?? 0).toFixed(2)}`}</div>
				</div>`;
		}

		function renderModal(data, provId) {
			const provs = Array.isArray(data.providers) ? data.providers : [];
			const prov = provs.find((p) => String(p.id) === String(provId)) ?? provs[0];
			const d = data.daily;
			const pv = (d !== void 0 && d !== null && prov !== void 0 ? d.providers?.[prov.id] : void 0)
				?? { today: { input: 0, cacheRead: 0, output: 0, cost: 0 }, month: { input: 0, cacheRead: 0, output: 0, cost: 0 }, total: { input: 0, cacheRead: 0, output: 0, cost: 0 }, cacheRate: null, models: [] };
			const row = (k, v, cls) => `<div class="dbc-row ${cls ?? ""}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
			const num = (n) => Number(n ?? 0).toLocaleString("en-US");

			const selHtml = provs.length > 1
				? `<select id="dbc-prov" class="dbc-select">${provs.map((p) => `<option value="${esc(p.id)}"${prov !== void 0 && p.id === prov.id ? " selected" : ""}>${esc(p.displayName ?? p.id)}</option>`).join("")}</select>`
				: provs.length === 1 ? `<div class="dbc-provname">${esc(provs[0].displayName ?? provs[0].id)}</div>` : "";

			const card = (label, b) => `<div class="dbc-stat"><div class="n">${num(b.input + b.cacheRead + b.output)}</div><div class="c">${fmtMoney(b.cost)}</div><div class="h">${label}</div></div>`;
			const statHtml =
				"<h3>Token 用量</h3>" +
				`<div class="dbc-statgrid">${card("今日", pv.today)}${card("本月", pv.month)}${card("累计", pv.total)}</div>` +
				row("缓存命中率", pv.cacheRate === null || pv.cacheRate === void 0 ? "--" : (pv.cacheRate * 100).toFixed(1) + "%");

			const models = Array.isArray(pv.models) ? pv.models : [];
			const modelsHtml = models.length > 0
				? `<div class="dbc-models">${models.map((m) => `<div class="dbc-model"><span class="dbc-model-name">${esc(String(m.model).replace("deepseek-v4-", ""))}</span><span class="dbc-model-tok">${fmtTokens(m.input + m.cacheRead + m.output)} tok</span><b>${fmtMoney(m.cost)}</b></div>`).join("")}</div>`
				: "";

			const pricing = Array.isArray(data.cost?.pricing) ? data.cost.pricing : [];
			const myCost = (shortName) => {
				const m = models.find((x) => String(x.model).replace("deepseek-v4-", "") === shortName)
				return m === void 0 ? "--" : fmtMoney(m.cost)
			}
			const costHtml = pricing.length > 0
				? `<table class="dbc-price"><thead><tr><th>模型</th><th>输入</th><th>缓存</th><th>输出</th><th>我的花费</th></tr></thead><tbody>` +
					pricing.map((p) => `<tr><td>${esc(p.model)}</td><td>${p.miss}元/M</td><td>${p.hit}元/M</td><td>${p.out}元/M</td><td class="dbc-price-me">${myCost(p.model)}</td></tr>`).join("") +
					`<tr class="dbc-price-total"><td>合计</td><td colspan="3"></td><td>${fmtMoney(pv.total.cost)}</td></tr>` +
					`</tbody></table>`
				: "";

			const calendarHtml = `<h3>Token 活动</h3>
				<div class="dbc-usage-heat">
					<div class="dbc-heat-summary"></div>
					<div class="dbc-heat-months"></div>
					<div class="dbc-heat-body">
						<div class="dbc-heat-wk"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span></span></div>
						<div class="dbc-heat-grid"></div>
					</div>
					<div class="dbc-heat-legend"><span>较少</span><i class="dbc-hl-0"></i><i class="dbc-hl-1"></i><i class="dbc-hl-2"></i><i class="dbc-hl-3"></i><i class="dbc-hl-4"></i><span>较多</span></div>
				</div>`;

			return `
				<h2>余额与用量<button class="dbc-close" type="button" aria-label="关闭">✕</button></h2>
				${selHtml}
				<div id="dbc-account-slot">${renderProviderCard(prov)}</div>
				${statHtml}
				${modelsHtml}
				${calendarHtml}
				<h3>费用估算${data.cost?.peak === true ? " · 高峰价" : ""}</h3>${costHtml}
				<div class="dbc-note">费用按各模型官方定价分别估算（${esc(String(data.cost?.deckLabel ?? "--"))}）；用量为本地会话统计并按所选供应商过滤。</div>
				<button class="dbc-refresh" type="button">刷新余额</button>
			`;
		}
		const shortModel = (m) => String(m).replace("deepseek-v4-", "");

		/** ZCode-style token activity heatmap: weekly columns (Mon first), 7 rows,
		 *  5 discrete levels (sqrt-damped quantile), bordered rounded cells with
		 *  hover scale, month ticks, busiest-day summary. Tooltip carries the
		 *  per-model breakdown from perDay.models. */
		function mountHeatmap(container, perDay) {
			if (container === null || perDay === void 0) return;
			const totalOf = (x) => (x?.input ?? 0) + (x?.cacheRead ?? 0) + (x?.output ?? 0);
			const byDay = new Map(perDay.map((x) => [x.date, x]));
			const pad = (x) => String(x).padStart(2, "0");
			const kOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
			const today = new Date();
			const monday = new Date(today);
			monday.setDate(monday.getDate() - (today.getDay() + 6) % 7);
			// 固定 18 周（≈ 服务端 perDay 的 120 天窗口）：列数恒定格子才恒定，
			// 数据稀疏时显示中性底色的空白格子，与 ZCode/GitHub 的固定年度网格一致
			const weeks = 18;
			const start = new Date(monday);
			start.setDate(start.getDate() - (weeks - 1) * 7);
			const maxV = Math.max(1, ...perDay.map(totalOf));
			let cells = "";
			let months = "";
			let lastMonth = -1;
			for (let w = 0; w < weeks; w++) {
				const weekStart = new Date(start);
				weekStart.setDate(start.getDate() + w * 7);
				if (weekStart.getMonth() !== lastMonth) {
					lastMonth = weekStart.getMonth();
					// GitHub/Codex 式月份刻度：锚定月份起始列、单列宽、文字右溢；
					// 末列右对齐避免溢出网格右缘
					const alignEnd = w === weeks - 1 ? ";justify-self:end" : "";
					months += `<span style="grid-column:${w + 1}${alignEnd}">${weekStart.getMonth() + 1}月</span>`;
				}
				for (let i = 0; i < 7; i++) {
					const day = new Date(weekStart);
					day.setDate(weekStart.getDate() + i);
					const key = kOf(day);
					const entry = day <= today ? byDay.get(key) : void 0;
					const v = entry !== void 0 ? totalOf(entry) : 0;
					// sqrt damps single-day spikes; 5 discrete levels like ZCode's heatmap-0..4
					const t = v === 0 ? 0 : Math.sqrt(v / maxV);
					const level = t === 0 ? 0 : 1 + Math.min(3, Math.floor(t * 4));
					let title = `${key} · ${fmtTokens(v)} tok`;
					if (entry?.models !== void 0) {
						const parts = Object.entries(entry.models).filter(([, n]) => n > 0).map(([m, n]) => `${shortModel(m)} ${fmtTokens(n)}`);
						if (parts.length > 0) title += `（${parts.join(" / ")}）`;
					}
					cells += `<i class="dbc-heat-cell dbc-hl-${level}" title="${esc(title)}"></i>`;
				}
			}
			container.querySelector(".dbc-heat-grid").innerHTML = cells;
			container.querySelector(".dbc-heat-months").innerHTML = months;
			let busiest = null;
			for (const x of perDay) {
				if (busiest === null || totalOf(x) > totalOf(busiest)) busiest = x;
			}
			const summary = container.querySelector(".dbc-heat-summary");
			if (busiest !== null && totalOf(busiest) > 0) {
				const [y, m, d] = busiest.date.split("-");
				summary.textContent = `最活跃日期是 ${Number(m)}月${Number(d)}日，约 ${fmtTokens(totalOf(busiest))} tokens`;
			}
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

			const onKey = (e) => { if (e.key === "Escape") close(); };
			const close = () => { document.removeEventListener("keydown", onKey); overlay.remove(); };
			document.addEventListener("keydown", onKey);
			overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

			const paint = (data) => {
				const first = Array.isArray(data.providers) && data.providers.length > 0 ? data.providers[0].id : null;
				const current = modal.dataset.dbcProv ?? first;
				modal.innerHTML = renderModal(data, current);
				mountHeatmap(modal.querySelector(".dbc-usage-heat"), data.daily?.perDay);
				const provSel = modal.querySelector("#dbc-prov");
				if (provSel !== null) {
					provSel.value = String(current);
					provSel.addEventListener("change", () => {
						modal.dataset.dbcProv = provSel.value;
						paint(data);
					});
				}
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
				const styleSrc = rowEl ?? anchor;
				const rowClass = styleSrc.className;
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
				// 供应商变化才刷新：aria-label 观察器（防抖 300ms）+ 5 秒兜底轮询共用同一个
				// fiber 对比；观察器会被无关的 title/aria-label 变更高频触发，但只在
				// provider 真正变化时才 fetch。
				let lastProvider = readCurrentProviderSafe();
				const refreshIfProviderChanged = () => {
					const cur = readCurrentProviderSafe();
					if (cur === lastProvider) return;
					lastProvider = cur;
					refreshValue();
				};
				let modelDebounce = null;
				const modelObs = new MutationObserver(() => {
					if (modelDebounce !== null) return;
					modelDebounce = setTimeout(() => { modelDebounce = null; refreshIfProviderChanged(); }, 300);
				});
				try { modelObs.observe(document.body, { attributes: true, attributeFilter: ["aria-label", "title"], subtree: true }); } catch { }
				const providerPoll = setInterval(refreshIfProviderChanged, 5000);
			let disposed = false;

			const labelEl = card.querySelector(".dbc-label");
			const refreshValue = async () => {
				if (disposed) return;
				try {
					const res = await fetch("/balance-card/balance", { cache: "no-store" });
					if (!res.ok) throw new Error("http-" + res.status);
					const data = await res.json();
					if (disposed) return;
					const wanted = readCurrentProviderSafe();
					const all = data.providers ?? [];
					const prov = all.find((x) => x.id === wanted) ?? all.find((x) => x.id === "deepseek-official") ?? all[0] ?? data.balance;
					if (prov === void 0 || prov.error !== void 0) {
						valueEl.textContent = "不可用";
						valueEl.classList.add("dbc-err");
						if (labelEl !== null) labelEl.textContent = "余额";
						return;
					}
					const cur = prov.currency === "USD" ? "$" : "\u00a5";
					valueEl.classList.remove("dbc-err");
					valueEl.textContent = cur + Number(prov.available ?? 0).toFixed(2);
					if (labelEl !== null) {
						const name = String(prov.displayName ?? prov.id ?? "余额");
						labelEl.textContent = name.length > 8 ? name.slice(0, 7) + "…" : name;
						labelEl.title = name;
					}
				} catch {
					valueEl.textContent = "离线";
					valueEl.classList.add("dbc-err");
					if (labelEl !== null) labelEl.textContent = "余额";
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

			const waitObserver = new MutationObserver(() => { tryPlace(); });
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

			// Wanted bottom stack: task-board entry above the balance card,
			// balance card above settings. The card itself uses the stable
			// settings-anchor path; the entry is moved down by this delayed
			// one-shot timer - deliberately outside every MutationObserver so
			// the task-board plugin's self-heal and this plugin never couple.

			return () => {
				disposed = true;
				clearInterval(timer);
				clearInterval(providerPoll);
				modelObs.disconnect();
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



