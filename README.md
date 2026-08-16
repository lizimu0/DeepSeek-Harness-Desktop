# dsh-desktop-suite

DeepSeek Harness（DSH）轻量桌面套件：**约 1MB 的 WebView2 桌面壳** + **多供应商余额与用量统计插件**。不依赖 Electron，窗口、图标、托盘全部自主可控。

## 组成

### launcher/ — 桌面壳（约 1MB）

用 .NET Framework + WebView2（系统自带运行时）把 `dsh web` 包成真正的桌面应用：

- **一键启动**：双击快捷方式自动探测 3080 端口，未运行则后台拉起 `dsh web`，就绪后打开窗口
- **托盘常驻**：叉掉窗口 = 收进托盘后台运行；托盘右键「退出」= 按端口精确结束 dsh 服务并退出
- **品牌启动画面**：窗口立即弹出显示鲸鱼 Logo 过渡，页面真正渲染后再揭开，避免白屏
- **余额/预算告警**：启动器每 5 分钟轮询插件告警接口，新告警弹托盘气泡通知（见「告警」一节）
- 单实例保护（Mutex + 事件），重复双击只唤起窗口
- 自定义鲸鱼图标（标题栏 / 任务栏 / 托盘）
- Per-Monitor V2 DPI 感知，高分屏渲染清晰；初始窗口按缩放比例取工作区 86%×88%
- WebView2 内核预热，与服务启动并行，减少等待

### plugin/ — dsh-balance-card 插件

在 dsh web 侧边栏「设置」正上方显示余额小卡片，点击弹出详情：

- **多供应商余额**：自动读取 `~/.dsh/settings.yaml` 里的 provider，逐个查询余额（DeepSeek 官方 `/user/balance`、硅基流动 `/v1/user/info`、其余走通用 OpenAI/New-API 探测）。无公开余额接口的供应商可在 `balance-offsets.json` 手动补录额度
- **跟随当前模型**：小卡片余额跟随当前会话所选模型的供应商；切换模型后即时刷新（React fiber 读取当前 provider，双保险：aria-label 观察器 + 5 秒轮询兜底）
- **Token 用量**：按供应商、按模型（flash/pro 分开）聚合本地会话日志，显示今日 / 本月 / 累计
- **费用估算**：内置官方定价表（含 2026-08-17 起峰谷定价，按日期与时段自动切换），按模型分项计费 + 合计
- **官方价格表**：详情弹窗展示各模型的输入/缓存/输出单价及当前估算费用
- 主题跟随 dsh 官方令牌（`--dsw-alias-*`），明暗皮肤自适应；另附右侧面板分隔缝修复样式

### quick-chat/ — dsh-quick-chat 插件

解决"每次必须选工作区"的问题：dsh web 启动后自动创建「chat」工作区（目录 `~/DeepSeek-Chats`）。在工作区列表里选它一次，之后新会话默认就是纯聊天（界面会记住最近使用的工作区）；项目开发继续用各自的项目工作区——工作区与聊天兼得，类似 Qoder / Codex 的体验。

### commands-zh/ — dsh-commands-zh 插件

把 dsh web 命令菜单（`+` 号弹出）里的英文命令描述替换成中文（精确匹配 + 前缀匹配两套规则）。

## 一键安装

把整个仓库放到任意稳定位置，运行：

```powershell
.\install.ps1             # 安装/更新三个插件 + 重启 dsh web
.\install.ps1 -Uninstall  # 卸载
```

脚本会自动完成：软链接三个插件到 web profile 的 `node_modules` → 登记 `package.json` 依赖与 bundle → 按 3080 端口终止旧服务并重启。幂等，可重复运行。

## 构建桌面壳

需要 Windows（WebView2 Runtime 为 Win11 自带）与 .NET Framework 4.x（系统自带）：

```powershell
cd launcher
.\get-webview2.ps1   # 从 NuGet 拉取 WebView2 控件（约 1MB，仅首次）
.\build.ps1          # 编译 exe + 生成图标 + 创建桌面快捷方式
```

## 配置

余额相关配置文件都放在 `~/.dsh/`，删除或不存在的文件使用默认值：

**`~/.dsh/balance-alert.json`** — 告警阈值（托盘气泡）
```json
{ "enabled": true, "lowBalance": 2, "dailyBudget": 5 }
```
- `lowBalance`：任一供应商余额 ≤ 此值时触发低余额告警
- `dailyBudget`：当日预估费用 ≥ 此值时触发超预算告警
- 每条告警每天最多触发一次

**`~/.dsh/balance-offsets.json`** — 手动额度修正（供应商 API 查不到的余额，如代金券）
```json
{ "siliconflow": 15.03, "token-rhythm": 67.81 }
```
余额会加上这里的偏移值（用于无公开余额接口的供应商或有代金券的账户）。

**`~/.dsh/.credentials.yaml`** — API Key（查询余额需要）
```yaml
DEEPSEEK_API_KEY: sk-xxx
```

## 定价维护

DeepSeek 调价时，编辑 `plugin/lib/index.js` 顶部的 `DECKS` 数组新增价目（元/百万 tokens），按生效日期自动切换。

## 许可

MIT © lizimu0