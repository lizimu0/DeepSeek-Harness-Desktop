using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

internal static class Program
{
    internal const int Port = 3080;
    public static readonly string Url = "http://127.0.0.1:" + Port;
    /** 就绪 URL（含 dsh 0.1.5+ 的 token）；服务输出解析到之前退回裸地址 */
    public static string WebUrl = Url;
    public static NotifyIcon Tray;
    public static MainForm Form;
    public static Process ServerCmd;
    private static readonly object OpenLock = new object();

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    internal static extern uint GetDpiForSystem();

    [STAThread]
    private static void Main()
    {
        try
        {
            if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
        }
        catch
        {
            try { SetProcessDPIAware(); } catch { }
        }
        bool createdNew;
        using (var mutex = new Mutex(true, @"Local\DeepSeekHarnessTray", out createdNew))
        {
            if (!createdNew)
            {
                try
                {
                    EventWaitHandle ev;
                    if (EventWaitHandle.TryOpenExisting(@"Local\DeepSeekHarnessShow", out ev))
                    {
                        ev.Set();
                        ev.Dispose();
                    }
                }
                catch { }
                return;
            }

            Application.EnableVisualStyles();
            Form = new MainForm();

            var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\DeepSeekHarnessShow");
            var waiter = new Thread(() =>
            {
                while (true)
                {
                    showEvent.WaitOne();
                    EnsureServerAndShow();
                }
            });
            waiter.IsBackground = true;
            waiter.Start();

            Tray = new NotifyIcon();
            Tray.Icon = LoadIcon();
            Tray.Text = "DeepSeek Harness";
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开 DeepSeek Harness", null, (s, e) => EnsureServerAndShow());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, (s, e) => QuitAll());
            Tray.ContextMenuStrip = menu;
            Tray.DoubleClick += (s, e) => EnsureServerAndShow();
            Tray.Visible = true;

            // Balance/budget alerts: poll the balance-card plugin and surface
            // new alert keys as tray balloon tips (once per key per local day,
            // remembered across launcher restarts).
            var alertClient = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            var seenAlerts = LoadSeenAlerts();
            var seenDay = DateTime.Now.ToString("yyyyMMdd");
            bool alertsEverSucceeded = false;
            var alertTimer = new System.Windows.Forms.Timer();
            alertTimer.Interval = 3000;
            alertTimer.Tick += (s2, e2) =>
            {
                string today = DateTime.Now.ToString("yyyyMMdd");
                if (today != seenDay) { seenDay = today; seenAlerts.Clear(); }
                try
                {
                    alertClient.GetStringAsync(Url + "/balance-card/alerts").ContinueWith(t =>
                    {
                        if (Form == null) return;
                        Form.BeginInvoke(new Action(() =>
                        {
                            if (t.IsFaulted)
                            {
                                // 服务未就绪时 15 秒后重试；成功过一次后保持 5 分钟节奏
                                if (!alertsEverSucceeded) alertTimer.Interval = 15000;
                                return;
                            }
                            alertsEverSucceeded = true;
                            alertTimer.Interval = 5 * 60 * 1000;
                            bool added = false;
                            try
                            {
                                var root = new System.Web.Script.Serialization.JavaScriptSerializer()
                                    .Deserialize<System.Collections.Generic.Dictionary<string, object>>(t.Result);
                                object listObj;
                                if (root != null && root.TryGetValue("alerts", out listObj) && listObj is System.Collections.ArrayList)
                                {
                                    foreach (object item in (System.Collections.ArrayList)listObj)
                                    {
                                        var entry = item as System.Collections.Generic.Dictionary<string, object>;
                                        if (entry == null) continue;
                                        object kv, mv;
                                        string key = entry.TryGetValue("key", out kv) ? kv as string : null;
                                        string message = entry.TryGetValue("message", out mv) ? mv as string : null;
                                        if (key == null || message == null) continue;
                                        if (seenAlerts.Add(key))
                                        {
                                            added = true;
                                            try { Tray.ShowBalloonTip(8000, "DeepSeek Harness", message, ToolTipIcon.Warning); } catch { }
                                        }
                                    }
                                }
                            }
                            catch { /* malformed body: skip */ }
                            if (added) SaveSeenAlerts(seenAlerts);
                        }));
                    });
                }
                catch { /* server down: silent */ }
            };
            alertTimer.Start();

            // Health monitor: dsh web dying while the launcher lives (crash, OOM,
            // external kill) used to leave a dead tray until the user reopened the
            // window. Poll every 60s and restart in the background — a visible
            // window reloads itself afterwards. Safe against double starts: the
            // probe runs under OpenLock (shared with the starter thread) and only
            // one restarter may be in flight, so a concurrently starting server is
            // detected before a second one is launched.
            var healthTimer = new System.Windows.Forms.Timer();
            healthTimer.Interval = 120 * 1000; // grace for a slow cold start; later ticks at 60s
            bool restartNotified = false;
            int restartInFlight = 0;
            healthTimer.Tick += (s2, e2) =>
            {
                healthTimer.Interval = 60 * 1000;
                if (Probe(2000)) { restartNotified = false; return; }
                if (System.Threading.Interlocked.CompareExchange(ref restartInFlight, 1, 0) != 0) return;
                var restarter = new Thread(() =>
                {
                    try
                    {
                        bool failed = false;
                        lock (OpenLock)
                        {
                            if (!Probe(1500))
                            {
                                string bin = FindDshBin();
                                string node = FindNode();
                                if (bin == null || node == null) failed = true;
                                else
                                {
                                    StartServer(node, bin);
                                    if (WaitReady(TimeSpan.FromSeconds(120)))
                                    {
                                        restartNotified = false;
                                        if (Form != null) Form.BeginInvoke(new Action(() => Form.ReloadIfVisible()));
                                    }
                                    else failed = true;
                                }
                            }
                        }
                        if (failed && !restartNotified)
                        {
                            restartNotified = true;
                            try
                            {
                                Form.BeginInvoke(new Action(() =>
                                {
                                    try { Tray.ShowBalloonTip(8000, "DeepSeek Harness", "dsh web 意外停止，自动重启失败；每分钟重试。日志：" + LogPath(), ToolTipIcon.Error); } catch { }
                                }));
                            }
                            catch { }
                        }
                    }
                    finally { System.Threading.Interlocked.Exchange(ref restartInFlight, 0); }
                });
                restarter.IsBackground = true;
                restarter.Start();
            };
            healthTimer.Start();

            var starter = new Thread(EnsureServerAndShow);
            starter.IsBackground = true;
            starter.Start();

            Application.Run(Form);
            Tray.Visible = false;
            Tray.Dispose();
        }
    }

    public static void ShowWindow()
    {
        if (Form == null) return;
        if (Form.InvokeRequired)
        {
            Form.BeginInvoke(new Action(ShowWindow));
            return;
        }
        Form.EnsureNavigated();
        Form.ActivateWindow();
    }

    private static void EnsureServerAndShow()
    {
        try
        {
            EnsureServerAndShowCore();
        }
        catch (Exception ex)
        {
            // 后台线程上的未处理异常会静默杀死显示路径：窗口不出现、splash 8 秒后
            // 撤掉露出空白 WebView2，之后托盘与单实例的显示信号也无人响应
            Log("EnsureServerAndShow 异常: " + ex);
            Fail("打开 DeepSeek Harness 失败：" + ex.Message + "\n日志：" + LauncherLogPath());
            try { ShowWindow(); } catch { }
        }
    }

    private static void EnsureServerAndShowCore()
    {
        lock (OpenLock)
        {
            bool alive = Probe(2000);
            Log("probe=" + (alive ? "alive" : "down"));
            if (!alive)
            {
                string bin = FindDshBin();
                string node = FindNode();
                if (bin == null) { Fail("未找到 dsh 安装（@deepseek-ai/dsh 的 lib/bin.js）。"); return; }
                if (node == null) { Fail("未找到 node.exe，请确认已安装 Node.js 并加入 PATH。"); return; }
                Log("start server node=" + node + " bin=" + bin);
                StartServer(node, bin);
                if (!WaitReady(TimeSpan.FromSeconds(120)))
                {
                    Fail("dsh web 未能在 120 秒内就绪。\n日志：" + LogPath());
                    return;
                }
                Log("server ready");
            }
            // 服务已就绪但还没拿到 token URL（例如本次打开时服务已在运行，
            // StartServer 没执行）：从日志里取最近一次启动打印的就绪 URL。
            // 旧 token 也不会死锁——WebView2 里已换发的 cookie 会继续放行。
            if (ReferenceEquals(WebUrl, Url)) AdoptTokenUrlFromLog();
            Log("webUrl=" + WebUrl);
        }
        if (Form != null) Form.SetSplashStatus("正在加载界面…");
        ShowWindow();
    }

    /** Scan the tail of the server log for the most recent ready URL (with token). */
    private static void AdoptTokenUrlFromLog()
    {
        try
        {
            string log = LogPath();
            if (!File.Exists(log)) return;
            using (var stream = new FileStream(log, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var reader = new StreamReader(stream))
            {
                string content = reader.ReadToEnd();
                var matches = System.Text.RegularExpressions.Regex.Matches(
                    content, @"http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+");
                if (matches.Count > 0) WebUrl = matches[matches.Count - 1].Value;
            }
        }
        catch { }
    }

    public static void QuitAll()
    {
        // 只终止本进程启动的 server;按端口查杀会误杀恰好占用 3080 的无关进程
        try
        {
            if (ServerCmd != null && !ServerCmd.HasExited) ServerCmd.Kill();
        }
        catch { }
        if (Form != null)
        {
            if (Form.InvokeRequired) Form.BeginInvoke(new Action(() => { Form.ReallyExit = true; Form.Close(); }));
            else { Form.ReallyExit = true; Form.Close(); }
        }
    }

    private static string LogPath()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", "web-server.log");
    }

    private static readonly object LauncherLogLock = new object();

    private static string LauncherLogPath()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh", "launcher.log");
    }

    /** 启动器自身决策日志：探活/拉起/导航/失败都留痕，白屏类故障才有证据链 */
    public static void Log(string message)
    {
        try
        {
            string path = LauncherLogPath();
            lock (LauncherLogLock)
            using (var fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
            using (var w = new StreamWriter(fs))
            {
                w.WriteLine("[" + DateTime.Now.ToString("MM-dd HH:mm:ss") + "] " + message);
            }
        }
        catch { }
    }

    private static bool Probe(int timeoutMs)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(Url);
            req.Timeout = timeoutMs;
            req.Method = "GET";
            using (var resp = (HttpWebResponse)req.GetResponse())
            {
                return true;
            }
        }
        catch (WebException ex)
        {
            // dsh 0.1.5+ 的裸路径返回 401（token 鉴权），而 GetResponse 对 4xx 抛
            // WebException：必须把"拿到了 HTTP 响应"当作服务已就绪，否则会误判为
            // 未启动并重复拉起服务（EADDRINUSE），最终 WebView2 永不导航而成白屏
            return ex.Response is HttpWebResponse;
        }
        catch
        {
            return false;
        }
    }

    private static void StartServer(string node, string bin)
    {
        string log = LogPath();
        Directory.CreateDirectory(Path.GetDirectoryName(log));
        // 日志无限追加会膨胀，超过 5MB 滚动为 .old
        try
        {
            FileInfo fi = new FileInfo(log);
            if (fi.Exists && fi.Length > 5 * 1024 * 1024)
            {
                string old = log + ".old";
                if (File.Exists(old)) File.Delete(old);
                File.Move(log, old);
            }
        }
        catch { }
        // 直接以 node 启动,不再经过 cmd.exe /c 字符串拼接(消除命令注入面),
        // 日志重定向改为自管:stdout/stderr 异步追加到同一文件
        // --no-open: dsh web 默认会打开系统默认浏览器,桌面壳用自己的 WebView2 窗口,别再弹浏览器
        var psi = new ProcessStartInfo(node, "\"" + bin + "\" web --no-open --port " + Port);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = Path.GetDirectoryName(bin);
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = System.Text.Encoding.UTF8;
        psi.StandardErrorEncoding = System.Text.Encoding.UTF8;
        ServerCmd = Process.Start(psi);
        var sync = new object();
        Action<string> appendLog = line =>
        {
            if (line == null) return;
            try
            {
                // dsh 0.1.5+ 的 Web UI 带 token 鉴权：启动输出会给出 /?token=… 的就绪 URL，
                // 抓下来供 WebView 导航（裸路径会 401）
                var m = System.Text.RegularExpressions.Regex.Match(
                    line, @"http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+");
                if (m.Success) WebUrl = m.Value;
                lock (sync)
                {
                    // 日志可能正被另一个启动器实例以 shell 重定向方式占用；
                    // AppendAllText 的默认共享模式会抛异常并把崩溃证据整个吞掉
                    using (var fs = new FileStream(log, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                    using (var w = new StreamWriter(fs))
                    {
                        w.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + line);
                    }
                }
            }
            catch { }
        };
        ServerCmd.OutputDataReceived += (s, e) => appendLog(e.Data);
        ServerCmd.ErrorDataReceived += (s, e) => appendLog(e.Data);
        ServerCmd.BeginOutputReadLine();
        ServerCmd.BeginErrorReadLine();
    }

    private static bool WaitReady(TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (Probe(1500)) return true;
            if (ServerCmd != null && ServerCmd.HasExited) return false;
            Thread.Sleep(250);
        }
        return Probe(1500);
    }

    private static string FindDshBin()
    {
        // 全局安装（npm i -g）是刻意安装的版本，优先于 npx 运行残留的缓存
        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string global = Path.Combine(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
        if (File.Exists(global)) return global;

        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string npxRoot = Path.Combine(local, "npm-cache", "_npx");
        if (Directory.Exists(npxRoot))
        {
            string best = null;
            Version bestVersion = null;
            DateTime bestTime = DateTime.MinValue;
            foreach (string dir in Directory.GetDirectories(npxRoot))
            {
                string p = Path.Combine(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
                if (!File.Exists(p)) continue;
                Version v = ReadPackageVersion(Path.Combine(dir, "node_modules", "@deepseek-ai", "dsh", "package.json"));
                DateTime t = File.GetLastWriteTimeUtc(p);
                bool better;
                if (best == null) better = true;
                else if (v != null && bestVersion != null) better = v > bestVersion || (v == bestVersion && t > bestTime);
                else if (v != null) better = true;
                else if (bestVersion != null) better = false;
                else better = t > bestTime;
                if (better) { best = p; bestVersion = v; bestTime = t; }
            }
            if (best != null) return best;
        }
        return null;
    }

    /** Parse "version" out of package.json (prerelease suffix stripped for comparability). */
    private static Version ReadPackageVersion(string pkgJson)
    {
        try
        {
            foreach (string line in File.ReadLines(pkgJson))
            {
                string s = line.Trim();
                if (!s.StartsWith("\"version\"")) continue;
                int colon = s.IndexOf(':');
                if (colon < 0) continue;
                string val = s.Substring(colon + 1).Trim().Trim(',').Trim('"');
                int dash = val.IndexOf('-');
                if (dash > 0) val = val.Substring(0, dash);
                Version v;
                if (Version.TryParse(val, out v)) return v;
                return null;
            }
        }
        catch { }
        return null;
    }

    static readonly string SeenAlertsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeepSeekHarness", "seen-alerts.txt");

    /** Already-shown alert keys for today; stale days are ignored. */
    private static System.Collections.Generic.HashSet<string> LoadSeenAlerts()
    {
        var seen = new System.Collections.Generic.HashSet<string>();
        try
        {
            string[] lines = File.ReadAllLines(SeenAlertsPath);
            if (lines.Length > 0 && lines[0] == "v1:" + DateTime.Now.ToString("yyyyMMdd"))
            {
                for (int i = 1; i < lines.Length; i++)
                    if (lines[i].Length > 0) seen.Add(lines[i]);
            }
        }
        catch { }
        return seen;
    }

    private static void SaveSeenAlerts(System.Collections.Generic.HashSet<string> seen)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(SeenAlertsPath));
            var lines = new System.Collections.Generic.List<string>();
            lines.Add("v1:" + DateTime.Now.ToString("yyyyMMdd"));
            lines.AddRange(seen);
            File.WriteAllLines(SeenAlertsPath, lines.ToArray());
        }
        catch { }
    }

    private static string FindNode()
    {
        // dsh 0.1.5+ 的 bin.js 依赖 import.meta.main（Node 24+）；系统 Node 可能较旧，
        // 优先使用随桌面壳部署的便携 Node（~\dsh-desktop\node\node.exe）
        string bundled = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "dsh-desktop", "node", "node.exe");
        if (File.Exists(bundled)) return bundled;
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var d in path.Split(Path.PathSeparator))
        {
            try
            {
                if (string.IsNullOrWhiteSpace(d)) continue;
                var p = Path.Combine(d.Trim().Trim('"'), "node.exe");
                if (File.Exists(p)) return p;
            }
            catch { }
        }
        string[] extras = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
        };
        foreach (var p in extras) if (File.Exists(p)) return p;
        return null;
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(IntPtr pTcpTable, ref int pdwSize, bool bOrder, int ulAf, int TableClass, uint Reserved);

    // FindPidByPort 已移除:按端口查杀进程会误杀恰好占用 3080 的无关进程,
    // 退出时只应终止本启动器自己拉起的 ServerCmd。

    public static Icon LoadIcon()
    {
        try
        {
            string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string png = Path.Combine(exeDir, "icon.png");
            if (File.Exists(png))
            {
                using (var bmp = new Bitmap(png))
                using (var small = new Bitmap(bmp, 32, 32))
                {
                    IntPtr hicon = small.GetHicon();
                    try { return Icon.FromHandle(hicon).Clone() as Icon; }
                    finally { DestroyIcon(hicon); }
                }
            }
        }
        catch { }
        return SystemIcons.Application;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    private static void Fail(string message)
    {
        Log("FAIL: " + message.Replace("\r", " ").Replace("\n", " | "));
        if (Form != null)
        {
            try { Form.BeginInvoke(new Action(() => Form.ShowErrorPage(message))); } catch { }
        }
        MessageBox.Show(message, "DeepSeek Harness", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}

internal class MainForm : Form
{
    public bool ReallyExit;
    private WebView2 _web;
    private bool _navigated;

    public MainForm()
    {
        Text = "DeepSeek Harness";
        Icon = Program.LoadIcon();
        ShowIcon = true;
        StartPosition = FormStartPosition.CenterScreen;
        float scale = 1f;
        try
        {
            uint dpi = Program.GetDpiForSystem();
            if (dpi > 0) scale = dpi / 96f;
        }
        catch { }
        var area = Screen.PrimaryScreen.WorkingArea;
        int w = Math.Max(760, (int)Math.Min(1280 * scale, area.Width * 0.86));
        int h = Math.Max(500, (int)Math.Min(840 * scale, area.Height * 0.88));
        Size = new Size(w, h);
        MinimumSize = new Size((int)(640 * scale), (int)(420 * scale));
        BackColor = System.Drawing.Color.White;
        _web = new WebView2();
        _web.Dock = DockStyle.Fill;
        try { _web.DefaultBackgroundColor = System.Drawing.Color.White; } catch { }
        Controls.Add(_web);
        _web.CoreWebView2InitializationCompleted += (s, e) =>
        {
            try
            {
                if (e.IsSuccess)
                {
                    var core = _web.CoreWebView2;
                    // 导航白名单:窗口承载 LLM 输出,页面内链接可能被提示注入到钓鱼站,
                    // 仅放行本机 dsh web 与本地产生的 about/data;其余 http(s) 转交系统浏览器
                    core.NavigationStarting += (s2, e2) =>
                    {
                        try
                        {
                            var uri = new Uri(e2.Uri);
                            bool local = uri.Scheme == "http"
                                && string.Equals(uri.Host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
                                && uri.Port == Program.Port;
                            bool localScheme = uri.Scheme == "about" || uri.Scheme == "data";
                            if (!local && !localScheme)
                            {
                                if (uri.Scheme == "http" || uri.Scheme == "https")
                                {
                                    try { Process.Start(new ProcessStartInfo(e2.Uri) { UseShellExecute = true }); }
                                    catch { }
                                }
                                e2.Cancel = true;
                            }
                        }
                        catch
                        {
                            e2.Cancel = true;
                        }
                    };
                    // target=_blank / window.open 统一转系统浏览器,避免弹出窗口绕过白名单
                    core.NewWindowRequested += (s2, e2) =>
                    {
                        try { Process.Start(new ProcessStartInfo(e2.Uri) { UseShellExecute = true }); }
                        catch { }
                        e2.Handled = true;
                    };
#if !DEBUG
                    // 发布版关闭 DevTools,减少暴露面(调试构建保留)
                    core.Settings.AreDevToolsEnabled = false;
#endif
                    core.AddScriptToExecuteOnDocumentCreatedAsync(
                        "(function(){function chk(){var ok=false;try{for(var i=0;i<document.body.children.length;i++){var n=document.body.children[i];if(n.tagName!=='SCRIPT'&&n.tagName!=='STYLE'&&n.getBoundingClientRect().height>50){ok=true;break}}}catch(x){}if(ok){try{window.chrome.webview.postMessage('dsh-ui-ready')}catch(x){}}else{setTimeout(chk,100)}}chk()})();");
                }
            }
            catch { }
        };
        _web.WebMessageReceived += (s, e) =>
        {
            try { if (e.TryGetWebMessageAsString() == "dsh-ui-ready") BeginInvoke(new Action(HideSplash)); } catch { }
        };
        try { _web.EnsureCoreWebView2Async(); } catch { }
        BuildSplash();
    }

    private Panel _splash;
    private PictureBox _splashPic;
    private Label _splashLabel;

    /** Branded splash shown instantly while WebView2 warms up and the page paints. */
    private void BuildSplash()
    {
        _splash = new Panel();
        _splash.Dock = DockStyle.Fill;
        _splash.BackColor = System.Drawing.Color.White;
        _splashPic = new PictureBox();
        try
        {
            string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string png = Path.Combine(exeDir, "icon.png");
            if (File.Exists(png)) _splashPic.Image = new Bitmap(png);
        }
        catch { }
        _splashPic.SizeMode = PictureBoxSizeMode.Zoom;
        _splashPic.Size = new Size(110, 110);
        _splashLabel = new Label();
        _splashLabel.Text = "DeepSeek Harness 正在启动服务…";
        _splashLabel.AutoSize = true;
        _splashLabel.ForeColor = System.Drawing.Color.FromArgb(70, 70, 80);
        _splashLabel.Font = new Font("Segoe UI", 11f);
        _splash.Controls.Add(_splashPic);
        _splash.Controls.Add(_splashLabel);
        Controls.Add(_splash);
        _splash.BringToFront();
        _splash.Resize += (s2, e2) => CenterSplash();
        CenterSplash();
        var fallback = new System.Windows.Forms.Timer();
        fallback.Interval = 8000;
        fallback.Tick += (s2, e2) => { fallback.Stop(); HideSplash(); };
        fallback.Start();
    }

    private void CenterSplash()
    {
        if (_splash == null || _splashPic == null || _splashLabel == null) return;
        _splashPic.Left = (_splash.ClientSize.Width - _splashPic.Width) / 2;
        _splashPic.Top = (_splash.ClientSize.Height - _splashPic.Height) / 2 - 40;
        _splashLabel.Left = (_splash.ClientSize.Width - _splashLabel.Width) / 2;
        _splashLabel.Top = _splashPic.Top + _splashPic.Height + 24;
    }

    /** Remove the splash once the web content has actually painted. */
    public void HideSplash()
    {
        if (_splash == null) return;
        _splash.Visible = false;
        ActivateWindow();
    }

    /** Update the splash status line (safe from any thread). */
    public void SetSplashStatus(string text)
    {
        if (_splash == null || _splashLabel == null) return;
        if (InvokeRequired) { BeginInvoke(new Action<string>(SetSplashStatus), text); return; }
        _splashLabel.Text = text;
        CenterSplash();
    }

    /** Restore from minimized + focus. */
    public void ActivateWindow()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }

    /** Reload the webview after a background server restart — only when the
     *  window is on screen; a hidden window re-navigates on next open anyway.
     *  Navigates to the fresh ready URL (new boot mints a new token). */
    public void ReloadIfVisible()
    {
        try
        {
            if (!Visible) return;
            if (_web != null && _web.CoreWebView2 != null && Program.WebUrl != null) _web.Source = new Uri(Program.WebUrl);
        }
        catch { }
    }

    public void EnsureNavigated()
    {
        if (_navigated) return;
        _navigated = true;
        try
        {
            // dsh 0.1.5+ 需要 token 化的就绪 URL；解析到之前用裸地址（老版本兼容）
            Program.Log("navigate " + Program.WebUrl);
            _web.Source = new Uri(Program.WebUrl);
        }
        catch (Exception ex)
        {
            _navigated = false;
            Program.Log("navigate failed: " + ex.Message);
        }
    }

    /** 失败时把窗口亮出来并给出可读原因；白窗本身就是最难排查的症状 */
    public void ShowErrorPage(string reason)
    {
        try
        {
            string html = "<!doctype html><meta charset='utf-8'><body style='font:14px/1.8 system-ui,sans-serif;padding:48px;color:#333'>"
                + "<h2 style='font-size:16px;margin:0 0 12px'>DeepSeek Harness 未能加载界面</h2>"
                + "<pre style='white-space:pre-wrap;color:#a00;font:12px/1.6 monospace'>"
                + System.Net.WebUtility.HtmlEncode(reason ?? "") + "</pre>"
                + "<p style='color:#888'>处理后可从托盘图标重新打开；启动器决策日志见 ~/.dsh/launcher.log</p></body>";
            _web.Source = new Uri("data:text/html;charset=utf-8," + Uri.EscapeDataString(html));
            ActivateWindow();
        }
        catch { }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!ReallyExit)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        try { _web.Dispose(); } catch { }
        base.OnFormClosing(e);
    }
}














