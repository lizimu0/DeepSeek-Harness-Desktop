window.__ModuleLoader__.load({
	id: "dsh-commands-zh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Exact-match translations for command descriptions. */
		const EXACT = {
			"Compact older conversation history": "压缩较早的对话历史",
			"Download this Session log as a ZIP archive": "将会话日志导出为 ZIP 压缩包",
			"record feedback about this session": "对本会话提交反馈",
			"set or view the goal for a long-running task": "为长任务设置或查看目标",
			"Switch the permission preset (sandbox mode + approval policy)": "切换权限预设（沙箱模式 + 审批策略）",
			"Enter or leave plan mode": "进入或退出计划模式",
			"Full file access without approval prompts.": "完全文件访问，无需审批确认。",
			"Write inside the workspace and permitted temporary directories; wider retries require approval.": "可写入工作区与允许的临时目录；更大范围的写入需要审批。",
			"Current sandbox and approval settings do not match a preset.": "当前沙箱与审批设置不匹配任何预设。",
			"List notes": "列出笔记",
			"Read the notes files and summarize": "读取笔记文件并汇总",
		};

		/** Prefix-match translations (long skill blurbs may vary slightly). */
		const PREFIX = [
			["Create, modify, debug, or extend dynamic Cordis Plugins", "创建、修改、调试或扩展动态 Cordis 插件（含宿主服务与事件、客户端槽位与主题 UI、包内私有的客户端到宿主调用、动态工具、版本更新、审批失败与运行时诊断）。用本技能把用户请求路由到正确的平台与 Inspect Provider，然后定义、运行、修复或回滚插件。"],
			["Use when creating, changing, or validating a Cordis composition", "在为本 harness 创建、修改或校验 Cordis 组合时使用——编写或编辑 agent 预设、增删插件行、判断某配置属于宿主组合还是单个会话、检查自己编写的预设是否真正挂载，或诊断已挂载但没有贡献任何内容的行。"],
		];

		function translateOf(text) {
			if (typeof text !== "string") return void 0;
			const key = text.trim();
			if (key === "") return void 0;
			if (Object.prototype.hasOwnProperty.call(EXACT, key)) return EXACT[key];
			for (const [prefix, zh] of PREFIX) {
				if (key.startsWith(prefix)) return zh;
			}
			return void 0;
		}

		/** Replace known English descriptions inside one listbox. */
		function translate(listbox) {
			const walker = document.createTreeWalker(listbox, NodeFilter.SHOW_TEXT);
			let node;
			while ((node = walker.nextNode()) !== null) {
				const zh = translateOf(node.nodeValue);
				if (zh !== void 0 && node.nodeValue.trim() !== zh) node.nodeValue = zh;
			}
		}

		function apply(ctx) {
			if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
			const selector = '[role="listbox"]';
			const observers = new Map();
			const pendingRoots = new Set();
			const dirtyListboxes = new Set();
			let disposed = false;
			let scanTimer = null;
			let bodyObs = null;

			const scheduleScan = () => {
				if (disposed || scanTimer !== null) return;
				scanTimer = setTimeout(flush, 200);
			};
			const attach = (listbox) => {
				if (disposed || !listbox.isConnected || observers.has(listbox)) return;
				translate(listbox);
				// Virtual scrolling re-renders items: coalesce translations too.
				const obs = new MutationObserver(() => {
					if (disposed || !observers.has(listbox)) return;
					dirtyListboxes.add(listbox);
					scheduleScan();
				});
				observers.set(listbox, obs);
				obs.observe(listbox, { childList: true, subtree: true, characterData: true });
			};
			const scan = (root) => {
				if (disposed || !root.isConnected) return;
				if (root.matches(selector)) attach(root);
				for (const listbox of root.querySelectorAll(selector)) attach(listbox);
			};
			function flush() {
				scanTimer = null;
				if (disposed) return;
				for (const [listbox, obs] of observers) {
					if (listbox.isConnected && listbox.matches(selector)) continue;
					obs.disconnect();
					observers.delete(listbox);
					dirtyListboxes.delete(listbox);
				}
				// Only inspect added subtrees / changed roles, never rescan the page
				// for unrelated streaming text. Skip roots covered by another root.
				for (const root of pendingRoots) {
					let parent = root.parentElement;
					while (parent && !pendingRoots.has(parent)) parent = parent.parentElement;
					if (!parent) scan(root);
				}
				pendingRoots.clear();
				for (const listbox of dirtyListboxes) {
					const obs = observers.get(listbox);
					if (!obs) continue;
					translate(listbox);
					// Our own characterData writes do not need another translation pass.
					obs.takeRecords();
				}
				dirtyListboxes.clear();
			}
			const start = () => {
				if (disposed || bodyObs !== null || !document.body) return;
				bodyObs = new MutationObserver((records) => {
					if (disposed) return;
					let removed = false;
					for (const record of records) {
						if (record.type === "attributes") pendingRoots.add(record.target);
						else {
							for (const node of record.addedNodes) {
								if (node.nodeType === 1) pendingRoots.add(node);
							}
							if (observers.size) {
								for (const node of record.removedNodes) {
									if (node.nodeType === 1) { removed = true; break; }
								}
							}
						}
					}
					if (pendingRoots.size || removed) scheduleScan();
				});
				bodyObs.observe(document.body, {
					childList: true, subtree: true, attributes: true, attributeFilter: ["role"],
				});
				scan(document.body);
			};
			// Explicit effect ownership also handles function-style apply and client HMR.
			const dispose = ctx.effect(() => () => {
				disposed = true;
				document.removeEventListener("DOMContentLoaded", start);
				if (scanTimer !== null) clearTimeout(scanTimer);
				scanTimer = null;
				bodyObs?.disconnect();
				for (const obs of observers.values()) obs.disconnect();
				observers.clear();
				pendingRoots.clear();
				dirtyListboxes.clear();
			}, "commands-zh.observers");
			if (document.body) start();
			else document.addEventListener("DOMContentLoaded", start, { once: true });
			return dispose;
		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	}
});
