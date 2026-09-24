window.__ModuleLoader__.load({
	id: "dsh-balance-card",
	factory: () => {
		const CARD_SELECTOR = "button[data-dsh-balance-card]";
		const POLL_MS = 60 * 1000;
		const WEEKS = 18;
		const CELL_PITCH = 25;
		const CSS = `
			.dbc-fallback{display:flex;align-items:center;gap:8px;width:calc(100% - 16px);margin:4px 8px;padding:7px 10px;border:1px solid rgba(128,128,128,.22);border-radius:10px;background:rgba(128,128,128,.08);color:inherit;font:inherit;font-size:12px;cursor:pointer;text-align:left}
			.dbc-cloned{cursor:pointer}
			[data-dsh-taskboard-entry]{order:98 !important;flex:0 0 auto !important;height:34px !important;color:var(--dsw-alias-label-primary) !important;border-radius:12px !important;margin:4px -4px !important;padding:6px 2px 6px 10px !important;font-size:14px !important;line-height:22px !important;width:calc(100% + 8px) !important;box-sizing:border-box !important}
			button[data-dsh-balance-card]{order:99 !important;flex:0 0 auto !important;height:36px !important;min-height:36px !important;max-height:36px !important;display:flex;align-items:center;gap:8px}
			[class*="footArea"]{order:100 !important}
			.dbc-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
			.dbc-value{margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
			.dbc-value.dbc-err{opacity:.65;font-weight:400}
			.dbc-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));padding:16px;box-sizing:border-box}
			.dbc-modal{box-sizing:border-box;width:560px;max-width:100%;max-height:84vh;overflow:auto;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fff));color:var(--dsw-alias-label-primary,inherit);box-shadow:0 18px 60px rgba(0,0,0,.25);padding:20px 22px;font-size:13px;line-height:1.6}
			.dbc-modal h2{margin:0 0 12px;font-size:15px;display:flex;align-items:center;gap:8px}
			.dbc-modal h3{margin:18px 0 8px;font-size:13px}
			.dbc-close{margin-left:auto;border:none;background:transparent;color:inherit;font-size:16px;cursor:pointer;padding:2px 8px;border-radius:6px}
			.dbc-close:hover{background:rgba(128,128,128,.15)}
			.dbc-row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.15))}
			.dbc-row .k{opacity:.75}.dbc-row .v{font-weight:600;font-variant-numeric:tabular-nums}
			.dbc-note,.dbc-updated{margin-top:10px;font-size:11px;opacity:.7;overflow-wrap:anywhere}
			.dbc-error{padding:8px 10px;margin:8px 0;border-radius:6px;border:1px solid rgba(217,119,6,.35);background:rgba(217,119,6,.1);font-size:12px;overflow-wrap:anywhere}
			.dbc-refresh{margin-top:14px;padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1));color:inherit;cursor:pointer;font:inherit;font-size:12px}
			.dbc-refresh:disabled{opacity:.5;cursor:wait}
			.dbc-statgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:4px 0 2px}
			.dbc-stat{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:10px;padding:8px 10px;min-width:0;overflow-wrap:anywhere}
			.dbc-stat .h{font-size:11px;opacity:.7}.dbc-stat .n{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}.dbc-stat .c{font-size:11px;opacity:.8;margin-top:2px}
			.dbc-account{background:linear-gradient(135deg,rgba(59,130,246,.18),rgba(99,102,241,.10));border:1px solid rgba(59,130,246,.30);border-radius:12px;padding:12px 14px;margin:2px 0 4px}
			.dbc-account-err{background:rgba(128,128,128,.08);border-color:rgba(128,128,128,.22)}
			.dbc-select{max-width:100%;margin:2px 0 8px;padding:5px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.1));color:inherit;font:inherit;font-size:12px}
			.dbc-price-wrap{overflow-x:auto}.dbc-price{width:100%;border-collapse:collapse;margin-top:6px;font-size:12px}
			.dbc-price th{text-align:left;font-weight:500;opacity:.75;padding:4px 6px;border-bottom:1px solid rgba(128,128,128,.25)}
			.dbc-price td{padding:5px 6px;border-bottom:1px dashed rgba(128,128,128,.15);font-variant-numeric:tabular-nums}
			.dbc-models{margin-top:8px;display:flex;flex-direction:column;gap:4px}
			.dbc-model{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:10px;border:1px solid rgba(128,128,128,.18);border-radius:10px;padding:6px 12px;font-size:12px}
			.dbc-model-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dbc-model-tok{opacity:.7;font-variant-numeric:tabular-nums}.dbc-model b{font-variant-numeric:tabular-nums}
			.dbc-acct-head{display:flex;justify-content:space-between;align-items:center;gap:8px}.dbc-acct-id{display:flex;gap:10px;align-items:center;min-width:0}
			.dbc-logo{width:34px;height:34px;border-radius:50%;background:rgba(59,130,246,.12);color:#3b82f6;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:13px;flex:none}
			.dbc-name{font-weight:600;overflow-wrap:anywhere}.dbc-sub,.dbc-acct-line{font-size:11px;opacity:.75}.dbc-badge{font-size:11px;border-radius:999px;padding:2px 9px;flex:none;background:rgba(128,128,128,.12)}
			.dbc-amount{font-size:24px;font-weight:700;margin-top:8px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
			.dbc-usage-heat{margin-top:8px;max-width:100%;--dbc-cell:20px;--dbc-gap:5px;--dbc-axis:25px}
			.dbc-heat-summary{font-size:11px;opacity:.75;margin-bottom:8px}
			.dbc-heat-scroll{overflow-x:auto;padding:2px 2px 4px;max-width:100%}.dbc-heat-inner{width:470px}
			.dbc-heat-months{position:relative;width:445px;height:18px;font-size:12px;opacity:.75;margin:0 0 4px var(--dbc-axis)}
			.dbc-heat-months span{position:absolute;white-space:nowrap;line-height:18px}
			.dbc-heat-body{display:flex;gap:var(--dbc-gap);align-items:flex-start}
			.dbc-heat-wk{display:grid;grid-template-rows:repeat(7,var(--dbc-cell));gap:var(--dbc-gap);font-size:10px;opacity:.65;width:20px;flex:none}
			.dbc-heat-wk span{display:flex;align-items:center;line-height:1}
			.dbc-heat-grid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,var(--dbc-cell));grid-auto-columns:var(--dbc-cell);gap:var(--dbc-gap)}
			.dbc-heat-cell{box-sizing:border-box;width:var(--dbc-cell);height:var(--dbc-cell);border-radius:5px;border:1px solid transparent;transition:transform .12s,border-color .12s;cursor:default}
			.dbc-heat-cell:hover{transform:scale(1.1);border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.45));position:relative;z-index:1}
			.dbc-hl-0{background:rgba(128,128,128,.16)}.dbc-hl-1{background:rgba(59,130,246,.30)}.dbc-hl-2{background:rgba(59,130,246,.55)}.dbc-hl-3{background:rgba(59,130,246,.80)}.dbc-hl-4{background:#3b82f6}
			.dbc-heat-future{opacity:.35}.dbc-heat-today{border-color:var(--dsw-alias-label-primary,#3b82f6)}
			.dbc-heat-legend{display:flex;gap:4px;align-items:center;justify-content:flex-end;font-size:11px;opacity:.75;margin-top:9px}
			.dbc-heat-legend i{box-sizing:border-box;width:14px;height:14px;border-radius:4px;display:inline-block}
			.dbc-modal :focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
			@media(max-width:520px){.dbc-modal{padding:16px}.dbc-statgrid{gap:5px}.dbc-stat{padding:7px}.dbc-model{grid-template-columns:minmax(0,1fr) auto}.dbc-model-tok{display:none}}
			@media(prefers-reduced-motion:reduce){.dbc-heat-cell{transition:none}.dbc-heat-cell:hover{transform:none}}
		`;

		const finite = (n) => typeof n === "number" && Number.isFinite(n);
		const tokens = (n) => finite(n) && n >= 0 ? n : 0;
		const totalOf = (x) => tokens(x?.input) + tokens(x?.cacheRead) + tokens(x?.cacheWrite) + tokens(x?.output);
		const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
		const shortModel = (m) => String(m).replace(/^deepseek-v4-/, "");
		const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		const emptyStats = () => {
			const empty = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, costStatus: "empty" });
			return { today: empty(), month: empty(), total: empty(), models: [], perDay: [], cacheRate: null };
		};

		function fmtMoney(n, currency = "CNY") {
			if (!finite(n)) return "--";
			return (currency === "USD" ? "$" : currency === "CNY" ? "¥" : currency + " ") + n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
		}
		function fmtTokens(n) {
			if (!finite(n)) return "--";
			if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
			if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
			return n.toLocaleString("zh-CN");
		}
		function fmtCost(stat) {
			if (stat?.costStatus === "unknown" || !finite(stat?.cost)) return "未配置价格";
			return fmtMoney(stat.cost) + (stat.costStatus === "partial" ? "（部分）" : "");
		}
		function fmtTime(ts) {
			return finite(ts) && !Number.isNaN(new Date(ts).getTime()) ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "--";
		}
		function errorText(code) {
			return ({ "missing-api-key": "未配置密钥", "unsupported-balance-endpoint": "暂不支持余额查询", "http-401": "登录已失效，请从桌面端重新打开", "http-403": "访问未授权", "http-503": "统计服务暂不可用", "invalid-balance": "供应商返回了无效余额" })[code] ?? String(code ?? "暂不可用");
		}

		// DSH has no stable provider attribute on this button; keep private React access read-only and optional.
		function readCurrentProviderSafe() {
			try {
				const btn = document.querySelector('button[aria-label^="选择模型"], button[aria-label^="Select model"]');
				if (!btn) return null;
				const key = Object.keys(btn).find((k) => k.startsWith("__reactFiber$"));
				for (let fiber = btn[key], depth = 0; fiber && depth < 60; fiber = fiber.return, depth++) {
					for (let hook = fiber.memoizedState, hop = 0; hook && hop < 20; hook = hook.next, hop++) {
						const ms = hook.memoizedState;
						if (ms && typeof ms === "object" && typeof ms.current?.provider === "string" && typeof ms.current?.model === "string" && Array.isArray(ms.groups)) return ms.current.provider;
					}
				}
			} catch { }
			return null;
		}

		function renderProviderCard(p) {
			if (!p) return '<div class="dbc-error">未发现供应商配置</div>';
			const quota = p.kind === "quota";
			const manual = p.source === "manual";
			const adjusted = p.source === "adjusted";
			const unavailable = p.error !== undefined || (!quota && !finite(p.available));
			const badge = unavailable ? "不可用" : quota ? "非余额" : manual ? "手动记录" : adjusted ? "含手动修正" : "API 查询";
			const detail = unavailable ? errorText(p.error ?? "invalid-balance") : quota ? "供应商仅返回计费上限，不能视为账户可用余额。" : manual ? "手动维护的额度，不随实际消费自动扣减。" : `充值 ${fmtMoney(p.charged, p.currency)} · 赠送 ${fmtMoney(p.granted, p.currency)}`;
			return `<div class="dbc-account${unavailable || quota || manual ? " dbc-account-err" : ""}">
				<div class="dbc-acct-head"><div class="dbc-acct-id"><div class="dbc-logo">${esc(String(p.displayName ?? p.id).slice(0, 2).toUpperCase())}</div><div><div class="dbc-name">${esc(p.displayName ?? p.id)}</div><div class="dbc-sub">${manual ? "手动额度" : quota ? "计费额度信息" : "可用余额"}</div></div></div><span class="dbc-badge">${badge}</span></div>
				<div class="dbc-amount">${quota ? "未提供余额" : esc(fmtMoney(unavailable ? null : p.available, p.currency))}</div>
				<div class="dbc-acct-line">${esc(detail)}</div>
				${p.fetchedAt ? `<div class="dbc-acct-line">查询时间 ${esc(fmtTime(p.fetchedAt))} · 最长缓存 5 分钟</div>` : ""}
			</div>`;
		}

		function renderModal(data, providerId) {
			const providers = Array.isArray(data.providers) ? data.providers : [];
			const provider = providers.find((p) => p.id === providerId);
			const stats = data.daily?.providers?.[providerId] ?? emptyStats();
			const models = Array.isArray(stats.models) ? stats.models : [];
			const statCard = (label, stat) => `<div class="dbc-stat"><div class="n">${totalOf(stat).toLocaleString("zh-CN")}</div><div class="c">${esc(fmtCost(stat))}</div><div class="h">${label}</div></div>`;
			const pricing = Array.isArray(data.cost?.pricing) ? data.cost.pricing : [];
			const warning = data.daily?.ok === false ? '<div class="dbc-error" role="status">部分会话统计暂不可用；下方为已读取的数据，不代表完整用量。</div>' : "";
			return `<h2 id="dbc-modal-title">余额与用量<button class="dbc-close" type="button" aria-label="关闭">✕</button></h2>
				<div class="dbc-error" role="alert" hidden></div>
				${providers.length ? `<select id="dbc-prov" class="dbc-select" aria-label="统计供应商">${providers.map((p) => `<option value="${esc(p.id)}"${p.id === providerId ? " selected" : ""}>${esc(p.displayName ?? p.id)}</option>`).join("")}</select>` : ""}
				${renderProviderCard(provider)}${warning}
				<h3>Token 用量</h3><div class="dbc-statgrid">${statCard("今日", stats.today)}${statCard("本月", stats.month)}${statCard("累计", stats.total)}</div>
				<div class="dbc-row"><span class="k">缓存命中率</span><span class="v">${finite(stats.cacheRate) ? (Math.max(0, Math.min(1, stats.cacheRate)) * 100).toFixed(1) + "%" : "--"}</span></div>
				${models.length ? `<div class="dbc-models">${models.map((m) => `<div class="dbc-model"><span class="dbc-model-name" title="${esc(m.model)}">${esc(shortModel(m.model))}</span><span class="dbc-model-tok">${fmtTokens(totalOf(m))} tok</span><b>${esc(fmtCost(m))}</b></div>`).join("")}</div>` : ""}
				<h3>Token 活动</h3><div class="dbc-usage-heat"><div class="dbc-heat-summary"></div><div class="dbc-heat-scroll"><div class="dbc-heat-inner"><div class="dbc-heat-months"></div><div class="dbc-heat-body"><div class="dbc-heat-wk" aria-hidden="true"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span></span></div><div class="dbc-heat-grid" role="img" aria-label="近18周每日 Token 用量"></div></div><div class="dbc-heat-legend" aria-hidden="true"><span>较少</span>${[0, 1, 2, 3, 4].map((i) => `<i class="dbc-hl-${i}"></i>`).join("")}<span>较多</span></div></div></div></div>
				<h3>费用估算</h3><div class="dbc-row"><span class="k">所选供应商已知价格小计</span><span class="v">${esc(fmtCost(stats.total))}</span></div>
				<div class="dbc-note">历史用量按发生时的价格估算；未配置价格的模型不按 Flash 代算。第三方供应商以实际账单为准。</div>
				${pricing.length ? `<details><summary class="dbc-note">当前参考单价${data.cost.peak ? " · 高峰价" : ""}（元/百万 Token）</summary><div class="dbc-price-wrap"><table class="dbc-price"><thead><tr><th>模型</th><th>输入</th><th>缓存</th><th>输出</th></tr></thead><tbody>${pricing.map((p) => `<tr><td>${esc(p.model)}</td><td>${esc(p.miss)}</td><td>${esc(p.hit)}</td><td>${esc(p.out)}</td></tr>`).join("")}</tbody></table></div><div class="dbc-note">${esc(data.cost.deckLabel)}</div></details>` : ""}
				<button class="dbc-refresh" type="button">刷新余额</button><div class="dbc-updated">统计生成于 ${esc(fmtTime(data.generatedAt))}</div>`;
		}

		function mountHeatmap(container, perDay) {
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const start = new Date(today);
			start.setDate(start.getDate() - (today.getDay() + 6) % 7 - (WEEKS - 1) * 7);
			const byDay = new Map();
			for (const row of Array.isArray(perDay) ? perDay : []) {
				if (!/^\d{4}-\d{2}-\d{2}$/.test(row?.date ?? "")) continue;
				const date = new Date(row.date + "T00:00:00");
				if (dateKey(date) === row.date && date >= start && date <= today) byDay.set(row.date, row);
			}
			const max = Math.max(1, ...Array.from(byDay.values(), totalOf));
			const labels = [{ week: 0, month: start.getMonth() + 1 }];
			let cells = "";
			let busiest = null;
			for (let index = 0; index < WEEKS * 7; index++) {
				const day = new Date(start);
				day.setDate(start.getDate() + index);
				const key = dateKey(day);
				const entry = byDay.get(key);
				const value = totalOf(entry);
				const future = day > today;
				const level = value === 0 ? 0 : Math.min(4, 1 + Math.floor(Math.sqrt(value / max) * 4));
				if (day.getDate() === 1 && index > 0) labels.push({ week: Math.floor(index / 7), month: day.getMonth() + 1 });
				let title = future ? `${key} · 未来日期` : `${key} · ${fmtTokens(value)} tok`;
				const detail = Object.entries(entry?.models ?? {}).filter(([, n]) => finite(n) && n > 0).map(([m, n]) => `${shortModel(m)} ${fmtTokens(n)}`);
				if (detail.length) title += `（${detail.join(" / ")}）`;
				cells += `<i class="dbc-heat-cell dbc-hl-${level}${future ? " dbc-heat-future" : ""}${key === dateKey(today) ? " dbc-heat-today" : ""}" data-date="${key}" title="${esc(title)}"></i>`;
				if (value > totalOf(busiest)) busiest = entry;
			}
			const ticks = [];
			for (const label of labels) {
				if (ticks.length && label.week - ticks[ticks.length - 1].week < 2) ticks.pop();
				ticks.push(label);
			}
			container.querySelector(".dbc-heat-grid").innerHTML = cells;
			container.querySelector(".dbc-heat-months").innerHTML = ticks.map((label) => `<span style="${label.week === WEEKS - 1 ? "right:0" : `left:${label.week * CELL_PITCH}px`}">${label.month}月</span>`).join("");
			container.querySelector(".dbc-heat-summary").textContent = busiest ? `近18周最活跃：${busiest.date}，约 ${fmtTokens(totalOf(busiest))} tokens` : "所选供应商近18周暂无用量记录";
		}

		function openModal(request, updateCard, onClosed) {
			const previousFocus = document.activeElement;
			const previousOverflow = document.body.style.overflow;
			const controller = new AbortController();
			let closed = false;
			let current = readCurrentProviderSafe();
			const overlay = document.createElement("div");
			overlay.className = "dbc-overlay";
			const modal = document.createElement("div");
			modal.className = "dbc-modal";
			modal.setAttribute("role", "dialog");
			modal.setAttribute("aria-modal", "true");
			modal.setAttribute("aria-labelledby", "dbc-modal-title");
			modal.tabIndex = -1;
			modal.innerHTML = '<h2 id="dbc-modal-title">余额与用量<button class="dbc-close" type="button" aria-label="关闭">✕</button></h2><div role="status">加载中…</div>';
			overlay.appendChild(modal);
			document.body.appendChild(overlay);
			document.body.style.overflow = "hidden";
			const close = () => {
				if (closed) return;
				closed = true;
				controller.abort();
				document.removeEventListener("keydown", onKey);
				overlay.remove();
				if (document.body.style.overflow === "hidden") document.body.style.overflow = previousOverflow;
				if (previousFocus?.isConnected) previousFocus.focus();
				onClosed();
			};
			const onKey = (event) => {
				if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
				if (event.key !== "Tab") return;
				const controls = Array.from(modal.querySelectorAll('button:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')).filter((el) => !el.hidden);
				const first = controls[0], last = controls[controls.length - 1];
				if (!first) { event.preventDefault(); modal.focus(); return; }
				if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
				else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
			};
			document.addEventListener("keydown", onKey);
			overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
			modal.querySelector(".dbc-close").addEventListener("click", close);
			modal.querySelector(".dbc-close").focus();
			const paint = (data) => {
				if (closed) return;
				const providers = Array.isArray(data.providers) ? data.providers : [];
				if (!providers.some((p) => p.id === current)) current = providers[0]?.id ?? null;
				modal.innerHTML = renderModal(data, current);
				mountHeatmap(modal.querySelector(".dbc-usage-heat"), data.daily?.providers?.[current]?.perDay ?? []);
				modal.querySelector(".dbc-close").addEventListener("click", close);
				const select = modal.querySelector("#dbc-prov");
				select?.addEventListener("change", () => { current = select.value; paint(data); modal.querySelector("#dbc-prov")?.focus(); });
				modal.querySelector(".dbc-refresh").addEventListener("click", async (event) => {
					const button = event.currentTarget;
					button.disabled = true;
					button.textContent = "刷新中…";
					try {
						const next = await request("/balance-card/refresh", { method: "POST", signal: controller.signal });
						if (closed) return;
						paint(next);
						updateCard(next.providers);
						modal.querySelector(".dbc-refresh")?.focus();
					} catch (error) {
						if (closed) return;
						button.disabled = false;
						button.textContent = "重试刷新";
						const alert = modal.querySelector('[role="alert"]');
						alert.hidden = false;
						alert.textContent = errorText(error.message);
					}
				});
			};
			request("/balance-card/data", { signal: controller.signal }).then((data) => {
				paint(data);
				if (!closed) modal.querySelector(".dbc-close").focus();
			}).catch((error) => {
				if (closed) return;
				const status = modal.querySelector('[role="status"]');
				status.textContent = "加载失败：" + errorText(error.message);
				status.className = "dbc-error";
			});
			return close;
		}

		const ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9.5" rx="2"/><path d="M1.5 6.5h13"/><circle cx="11.5" cy="9.8" r="1" fill="currentColor" stroke="none"/></svg>';
		function sidebarRoot() {
			const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
			return column?.querySelector('[class*="logoRow"]')?.parentElement ?? column?.firstElementChild ?? null;
		}
		function placeCard(root, card) {
			const anchor = Array.from(root.querySelectorAll('button, [role="button"], a')).find((el) => /setting|设置/i.test(`${el.getAttribute("aria-label") ?? ""} ${el.title ?? ""} ${el.textContent ?? ""}`));
			let target = anchor;
			while (target && target.parentElement !== root) target = target.parentElement;
			card.className = typeof anchor?.className === "string" && anchor.className.trim() ? anchor.className + " dbc-cloned" : "dbc-fallback";
			root.insertBefore(card, target);
		}

		function apply(ctx) {
			if (typeof document === "undefined" || document.querySelector(CARD_SELECTOR)) return;
			let disposed = false;
			let closeModal = null;
			let inflight = null;
			let layoutTimer = null;
			let modelTimer = null;
			let watchedModel = null;
			let lastProvider = readCurrentProviderSafe();
			const controllers = new Set();
			const style = document.createElement("style");
			style.setAttribute("data-dsh-balance-style", "");
			style.textContent = CSS;
			document.head.appendChild(style);
			const card = document.createElement("button");
			card.type = "button";
			card.setAttribute("data-dsh-balance-card", "");
			card.setAttribute("aria-label", "余额与用量");
			card.innerHTML = `${ICON}<span class="dbc-label">余额</span><span class="dbc-value">…</span>`;
			const value = card.querySelector(".dbc-value"), label = card.querySelector(".dbc-label");
			const request = async (url, options = {}) => {
				const controller = new AbortController();
				const abort = () => controller.abort();
				if (disposed || options.signal?.aborted) controller.abort();
				options.signal?.addEventListener("abort", abort, { once: true });
				controllers.add(controller);
				const timeout = setTimeout(abort, 35000);
				try {
					const response = await fetch(url, { method: options.method ?? "GET", cache: "no-store", credentials: "same-origin", signal: controller.signal });
					if (!response.ok) throw new Error("http-" + response.status);
					const data = await response.json();
					if (data?.error) throw new Error(data.error);
					return data;
				} finally {
					clearTimeout(timeout);
					options.signal?.removeEventListener("abort", abort);
					controllers.delete(controller);
				}
			};
			const updateCard = (providers) => {
				if (disposed) return;
				const all = Array.isArray(providers) ? providers : [];
				const wanted = readCurrentProviderSafe() ?? lastProvider;
				const provider = wanted ? all.find((p) => p.id === wanted) : all[0];
				const name = String(provider?.displayName ?? provider?.id ?? "余额");
				label.textContent = name.length > 8 ? name.slice(0, 7) + "…" : name;
				if (label.title !== name) label.title = name;
				const usable = provider?.error === undefined && finite(provider?.available);
				// Keep the sidebar honest per state instead of a blanket "unavailable":
				// a provider without a balance API is not the same as an offline one.
				const short = usable
					? fmtMoney(provider.available, provider.currency)
					: provider?.kind === "quota" ? "非余额" : provider?.error === "unsupported-balance-endpoint" ? "无接口" : provider?.error === "missing-api-key" ? "无密钥" : "离线";
				value.textContent = short;
				value.classList.toggle("dbc-err", !usable);
				const note = provider?.source === "manual" ? "手动额度，不代表实时余额" : provider?.source === "adjusted" ? "API 余额含手动修正" : provider?.kind === "quota" ? "计费上限不能视为可用余额" : provider?.error ? errorText(provider.error) : "余额与用量";
				if (card.title !== note) card.title = note;
			};
			const refreshValue = () => {
				if (disposed || inflight) return inflight;
				inflight = request("/balance-card/balance").then((data) => updateCard(data.providers)).catch((error) => {
					if (disposed) return;
					value.textContent = "离线";
					value.classList.add("dbc-err");
					card.title = errorText(error.message);
				}).finally(() => { inflight = null; });
				return inflight;
			};
			const providerChanged = () => {
				if (disposed || document.hidden) return;
				const current = readCurrentProviderSafe();
				if (current !== lastProvider) { lastProvider = current; refreshValue(); }
			};
			const modelObserver = new MutationObserver(() => {
				if (modelTimer !== null) return;
				modelTimer = setTimeout(() => { modelTimer = null; providerChanged(); }, 150);
			});
			const ensurePlaced = () => {
				if (disposed) return;
				if (!card.isConnected) { const root = sidebarRoot(); if (root) placeCard(root, card); }
				const button = document.querySelector('button[aria-label^="选择模型"], button[aria-label^="Select model"]');
				if (button !== watchedModel) {
					modelObserver.disconnect();
					watchedModel = button;
					if (button) modelObserver.observe(button, { attributes: true, attributeFilter: ["aria-label", "title"] });
					providerChanged();
				}
			};
			const observer = new MutationObserver(() => {
				if (layoutTimer !== null) return;
				layoutTimer = setTimeout(() => { layoutTimer = null; ensurePlaced(); }, 150);
			});
			observer.observe(document.body, { childList: true, subtree: true });
			card.addEventListener("click", () => {
				if (!closeModal) closeModal = openModal(request, updateCard, () => { closeModal = null; });
			});
			const onVisibility = () => { if (!document.hidden) { ensurePlaced(); refreshValue(); } };
			document.addEventListener("visibilitychange", onVisibility);
			ensurePlaced();
			refreshValue();
			const poll = setInterval(() => { if (!document.hidden) refreshValue(); }, POLL_MS);
			const providerPoll = setInterval(providerChanged, 5000);
			const dispose = () => {
				if (disposed) return;
				disposed = true;
				clearInterval(poll);
				clearInterval(providerPoll);
				clearTimeout(layoutTimer);
				clearTimeout(modelTimer);
				observer.disconnect();
				modelObserver.disconnect();
				document.removeEventListener("visibilitychange", onVisibility);
				closeModal?.();
				for (const controller of controllers) controller.abort();
				card.remove();
				style.remove();
			};
			ctx?.effect?.(() => dispose);
			return dispose;
		}
		return { apply, inject: [] };
	}
});
