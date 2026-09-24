# DSH Desktop Suite

DeepSeek Harness 的本地 Windows 桌面壳与配套插件。桌面壳基于 .NET Framework + WebView2，不需要 Electron；官方 DSH 安装、用户配置与本仓库源码相互独立。

## 保持不变的使用习惯

- **不注册开机自启**。需要时双击打开，关闭窗口收进托盘，托盘「退出」才结束启动器。
- 启动 DSH 使用 `--no-open`，不额外弹出系统浏览器。
- 不自动升级系统 Node、官方 DSH 或第三方插件，不覆盖用户的模型、凭据、会话配置。
- Token 活动保留 **20px 小格子、5px 间隔、18 周 × 7 天**，没有用量的日期仍显示灰格。窄窗口只滚动图表，不撑破弹窗或放大格子。

## 组件

| 目录 | 功能 |
| --- | --- |
| `launcher/` | 桌面窗口、托盘、进程管理、认证与故障恢复 |
| `plugin/` | 余额、费用估算、Token 用量与告警 |
| `quick-chat/` | 创建独立的 `DeepSeek-Chats` 聊天工作区 |
| `commands-zh/` | 将已知命令描述替换为中文 |
| `follow-model/` | 子代理模型路由与系统提示的一致性兼容层 |

`relay-ua/` 是仓库历史遗留模块。本轮不维护、不扩展其客户端身份改写逻辑，安装器也不再把它作为默认安装或卸载目标；**既有登记不会被擅自删除**。供应商接入应使用对方允许的协议和客户端，不把规避服务准入作为兼容方案。

### 启动器

- 区分「端口有响应」与「DSH 页面可用」，404/500 不再当作就绪，也不因此对已有进程重复启动。
- 使用启动输出的 token 地址完成正常 Cookie 换发，验证页面后再导航；不关闭或绕过官方认证。
- 启动、恢复和退出采用单次进行、取消与资源清理机制，避免后台重试与手动打开抢同一端口。
- 默认只结束自己拉起的服务；不会按 `node.exe` 名字或仅凭端口批量结束进程。
- 外部链接仅允许 HTTP/HTTPS；不把文件路径或任意协议直接交给系统执行。
- 日志脱敏，不打印认证 token。认证状态与诊断信息不提交到仓库。

### 用量和余额

- 支持 DSH v0–v4 会话日志（v4 是 0.1.7 起的当前格式），读取每个会话最高代际的规范文件，同时覆盖普通会话和子会话；排除 fork 继承的历史，避免重复计数。
- `input`、`cacheRead`、`cacheWrite`、`output` 分开累计。缺失、损坏、正在写入或超出大小限制的数据明确提示“不完整”，不伪装成正常零用量。
- 每个供应商有独立的每日统计与模型明细，选择供应商时图表同步变化。
- 历史费用使用**事件发生时间**对应的参考价及上海峰谷时段。未配置价格的型号不冒用 Flash 价格，未定价部分显示“未配置价格/部分估算”。
- 原有两套价格表保留在 `plugin/lib/stats.js`；它们是现存参考配置，**不保证等于供应商当前账单或第三方渠道定价**。修改价格前应核对对应供应商的有效日期和计价规则。
- 供应商配置的读取顺序：官方 settings 服务（旧核心的命名空间读取）→ profile 的 `cordis.patch.yml`（0.1.7 起设置被导入到该文档）→ 旧的 `settings.yaml` 与 `settings.yaml.imported`。任一来源不可读都不会隐藏其他来源；凭据同理，优先官方 credentials 服务，其次环境变量与 `.credentials.yaml`。
- 成功余额最长缓存 5 分钟，错误缓存 15 秒，并发请求合并；手动修正独立于 API 缓存读取。
- **手动额度不是实时余额**。API 只返回计费上限时显示“非余额”，无公开余额接口的供应商显示“无接口”，都不把 `hard_limit` 当作账户资金。
- 余额和用量接口全部走 DSH 的 Host/Origin/Cookie 认证，刷新仅接受 POST。

### 子代理与生命周期

DSH 0.1.5-rc.2 本身已改进子代理对父请求路由的继承；不再沿用“官方永远只读旧 options”的过时描述。`follow-model` 在每步提示组装之前捕获直系父路由，让提示和请求使用同一个快照。父代理不在时保留子代理原有路由，**不跳到其他会话最近保存的全局默认模型**。

插件卸载使用 Cordis `effect` 管理。观察器、初始启动计时器、重试、请求与迟到的异步回调都受同一生命周期控制。

## 环境

- Windows 10/11、.NET Framework 4.8、WebView2 Runtime。
- Windows PowerShell 5.1 或 PowerShell 7。
- 建议 Node.js 24。旧的 Node 22.15 缺少 `import.meta.main`，会让部分 DSH CLI 入口静默退出；更新的 Node 22 版本可能已支持，不应把所有 Node 22 一概判为不可用。
- 可在 `%USERPROFILE%\dsh-desktop\node\node.exe` 放置便携 Node，避免改变系统 Node。便携运行时不是仓库自带文件，脚本不会自动下载或升级它。
- 本轮集成验证版本是 **DSH 0.1.5-rc.2**。`rc` 仍是候选发布版，npm 的 `latest` 标签不等于稳定性保证。

## 安装插件

先运行官方 DSH 初始化 web profile，再在仓库执行：

```powershell
.\install.ps1 -WhatIf
.\install.ps1                           # 登记四个维护插件；默认不重启
.\install.ps1 -Plugins plugin           # 仅安装/更新余额插件
.\install.ps1 -Plugins follow-model -Uninstall
.\install.ps1 -Restart                  # 显式要求重启；进程归属校验失败会停止
```

可用 `-Plugins` 值：`plugin`、`quick-chat`、`commands-zh`、`follow-model`，也接受相应包名。支持 `-ProfileDirectory <path>`、`-NoRestart`、`-WhatIf`。

安装器保留其他依赖/bundle，写入无 BOM UTF-8，保留原始文件备份并原子替换。普通目录、未知链接、外部依赖或运行中变化的目标会被拒绝，不会直接删除。

新增 YAML 解析依赖由仓库工作区统一安装：

```powershell
npm install --ignore-scripts
```

## 构建桌面壳

```powershell
.\launcher\get-webview2.ps1 -WhatIf
.\launcher\get-webview2.ps1              # 明确下载固定版本 SDK，不安装系统 Runtime
.\launcher\build.ps1 -BuildOnly -NoShortcut -OutputDirectory C:\Temp\dsh-build-new
```

- 默认 WebView2 SDK 版本为 `1.0.4129.50`，NuGet 下载包约 **9.2 MB**，并不是整个桌面运行时只有 1 MB。可通过 `-Version` 选择版本。
- 下载校验官方 SHA512、ZIP 白名单、程序集身份、微软签名；不会执行下载的脚本。
- `-BuildOnly`（别名 `-NoDeploy`）只在新目录生成校验过的程序；`-NoShortcut` 不改桌面快捷方式。
- 输出目录必须尚不存在，且不能与部署目录相互包含。
- 不带 `-BuildOnly` 才会部署到 `%USERPROFILE%\dsh-desktop`（可用 `-DeployDirectory` 调整）。**已有同名文件只有受管清单和 SHA256 都匹配才允许更新**，每次变更有备份，失败尝试回滚。
- 旧部署没有清单或已经被手改时，脚本会拒绝覆盖。先使用 `-BuildOnly` 检查新产物；旧部署迁移是独立的人工确认操作，不使用“强制覆盖”跳过保护。

## 配置

默认读取 `~/.dsh`，余额插件支持 `DSH_HOME` 的独立目录。配置文件不属于仓库，不会随构建或测试重写。

**`balance-alert.json`**

```json
{ "enabled": true, "lowBalance": 2, "dailyBudget": 5 }
```

低余额阈值按该供应商返回的币种比较；每日预算为已知参考价格的 CNY 小计，不是多币种账单汇总。未知费用不凭空触发零成本判断。告警以本地日历日去重，账本写回失败会显式报错并可重试。

**`balance-offsets.json`**

```json
{ "siliconflow": 15.03, "token-rhythm": 67.81 }
```

有真实余额时作为修正额；供应商明确不支持余额查询时作为手动记录。认证失败、网络超时不会被手动数值掩盖。JSON 数值必须有限，不能填字符串。手动数值不会自动随消费扣减。

**`.credentials.yaml`** 示例（不要将真实密钥提交到仓库）：

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: example-placeholder
```

供应商 API/额度由对方服务决定。历史 `/user/info` 等端点停用时，更新本项目不能恢复对方已撤掉的能力。

## 验证和排障

```powershell
npm run verify
npm run test:windows
npm run test:integration
npm run preview
```

详见 [开发和验证说明](docs/DEVELOPMENT.md)。JS 测试、Windows 测试和集成冒烟都使用临时数据，不发送付费模型请求。`preview` 提供虚构数据的独立本地页面，不是生产 DSH 服务。

桌面打不开时先查看 `~/.dsh/launcher.log` 与 `~/.dsh/web-server.log`。区分连接拒绝、认证失败、页面未就绪和插件加载失败；不要以“没有崩溃日志”推断用户一定手动退出，也不要以任意 HTTP 响应证明功能已就绪。分享旧日志前仍需脱敏，其中可能残留此前版本写入的 token。

## 许可

MIT © lizimu0
