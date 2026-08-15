# dsh-desktop-suite

DeepSeek Harness（DSH）轻量桌面套件：**约 1MB 的 WebView2 桌面壳** + **余额与用量卡片插件**。不依赖 Electron，窗口、图标、托盘全部自主可控。

## 组成

### launcher/ — 桌面壳（约 1MB）

用 .NET Framework + WebView2（系统自带运行时）把 `dsh web` 包成真正的桌面应用：

- 双击快捷方式一键启动：自动探测 3080 端口，未运行则后台拉起 `dsh web`，就绪后打开窗口
- 右下角托盘常驻：叉掉窗口 = 收进托盘后台运行；托盘右键「退出」= 按端口精确结束 dsh 服务并退出
- 单实例保护（Mutex + 事件），重复双击只会唤起窗口
- 自定义鲸鱼图标（标题栏 / 任务栏 / 托盘）
- Per-Monitor V2 DPI 感知，高分屏渲染清晰；初始窗口按缩放比例取工作区 86%×88%
- WebView2 内核预热，与服务启动并行，减少等待

### plugin/ — dsh-balance-card 插件

在 dsh web 侧边栏「设置」正上方显示余额小卡片，点击弹出详情：

- **账户余额**：DeepSeek 官方 `/user/balance` API 实时查询（5 分钟缓存，可手动刷新）
- **Token 用量**：聚合本地全部会话投影缓存（未命中输入 / 缓存命中 / 输出 / 会话轮次）
- **费用估算**：内置官方定价表（含 2026-08-17 起的峰谷定价，按日期与时段自动切换），分项计费 + 总费用
- 主题跟随 dsh 官方令牌（`--dsw-alias-*`），明暗皮肤自适应；另附右侧面板分隔缝修复样式

### quick-chat/ — dsh-quick-chat 插件

解决"每次必须选工作区"的问题：dsh web 启动后自动创建「💬 聊天」工作区（目录 `~/DeepSeek-Chats`）。在工作区列表里选它一次，之后新会话默认就是纯聊天（界面会记住最近使用的工作区）；项目开发继续用各自的项目工作区——工作区与聊天兼得，类似 Qoder / Codex 的体验。

## 构建桌面壳

需要 Windows（WebView2 Runtime 为 Win11 自带）与 .NET Framework 4.x（系统自带）：

```powershell
cd launcher
.\get-webview2.ps1   # 从 NuGet 拉取 WebView2 控件（约 1MB，仅首次）
.\build.ps1          # 编译 exe + 生成图标 + 创建桌面快捷方式
```

## 安装插件

把 `plugin/` 目录放到任意稳定位置（例如 `~\dsh-balance-card`），然后链接进 web profile：

```powershell
# 1. 软链接到 profile 的 node_modules
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-balance-card" `
  -Target "$env:USERPROFILE\dsh-balance-card"

# 2. 在 profile 的 package.json 中登记依赖与 bundle
#    dependencies: "dsh-balance-card": "link:<插件目录>"
#    dsh.profile.bundles 追加 "dsh-balance-card"

# 3. 重启 dsh web
```

插件需要 `~/.dsh/.credentials.yaml` 中配置 `DEEPSEEK_API_KEY` 才能查询余额。

## 定价维护

DeepSeek 调价时，编辑 `plugin/lib/index.js` 顶部的 `DECKS` 数组新增价目（元/百万 tokens），按生效日期自动切换。

## 许可

MIT © lizimu0

