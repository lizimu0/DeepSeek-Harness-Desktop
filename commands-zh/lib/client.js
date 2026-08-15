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
		};

		/** Prefix-match translations (long skill blurbs may vary slightly). */
		const PREFIX = [
			["Create, modify, debug, or extend dynamic Cordis Plugins", "创建、修改、调试或扩展动态 Cordis 插件（含宿主服务与事件、客户端槽位与主题 UI、包内私有的客户端到宿主调用、动态工具、版本更新、审批失败与运行时诊断）。用本技能把用户请求路由到正确的平台与 Inspect Provider，然后定义、运行、修复或回滚插件。"],
			["Use when creating, changing, or validating a Cordis composition", "在为本 harness 创建、修改或校验 Cordis 组合时使用——编写或编辑 agent 预设、增删插件行、判断某配置属于宿主组合还是单个会话、检查自己编写的预设是否真正挂载，或诊断已挂载但没有贡献任何内容的行。"],
		];

		function translateOf(text) {
			const key = text.trim();
			if (key === "") return void 0;
			if (EXACT[key] !== void 0) return EXACT[key];
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

		function apply() {
			if (typeof document === "undefined") return;
			const attached = new WeakSet();

			const attach = (listbox) => {
				if (attached.has(listbox)) return;
				attached.add(listbox);
				translate(listbox);
				// Virtual scrolling re-renders items: keep translating.
				const obs = new MutationObserver(() => translate(listbox));
				obs.observe(listbox, { childList: true, subtree: true, characterData: true });
			};

			const scan = () => {
				for (const listbox of document.querySelectorAll('[role="listbox"]')) attach(listbox);
			};

			const bodyObs = new MutationObserver(() => scan());
			bodyObs.observe(document.body, { childList: true, subtree: true });
			scan();
		}

		exports.apply = apply;
		exports.inject = [];
		return module.exports;
	}
});
