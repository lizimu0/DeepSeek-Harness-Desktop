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
    private const int Port = 3080;
    public static readonly string Url = "http://127.0.0.1:" + Port;
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
            // new alert keys as tray balloon tips (once per key per app run).
            var alertClient = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromSeconds(8) };
            var seenAlerts = new System.Collections.Generic.HashSet<string>();
            var alertTimer = new System.Windows.Forms.Timer();
            alertTimer.Interval = 3000;
            alertTimer.Tick += (s2, e2) =>
            {
                alertTimer.Interval = 5 * 60 * 1000;
                try
                {
                    alertClient.GetStringAsync(Url + "/balance-card/alerts").ContinueWith(t =>
                    {
                        if (t.IsFaulted || Form == null) return;
                        string body = t.Result;
                        Form.BeginInvoke(new Action(() =>
                        {
                            foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(
                                body, @"\{""key"":""(?<k>[^""]+)"",""message"":""(?<m>[^""]*)"""))
                            {
                                if (seenAlerts.Add(m.Groups["k"].Value))
                                {
                                    try { Tray.ShowBalloonTip(8000, "DeepSeek Harness", m.Groups["m"].Value, ToolTipIcon.Warning); } catch { }
                                }
                            }
                        }));
                    });
                }
                catch { /* server down: silent */ }
            };
            alertTimer.Start();

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
        lock (OpenLock)
        {
            if (!Probe(2000))
            {
                string bin = FindDshBin();
                string node = FindNode();
                if (bin == null) { Fail("未找到 dsh 安装（@deepseek-ai/dsh 的 lib/bin.js）。"); return; }
                if (node == null) { Fail("未找到 node.exe，请确认已安装 Node.js 并加入 PATH。"); return; }
                StartServer(node, bin);
                if (!WaitReady(TimeSpan.FromSeconds(120)))
                {
                    Fail("dsh web 未能在 120 秒内就绪。\n日志：" + LogPath());
                    return;
                }
            }
        }
        if (Form != null) Form.SetSplashStatus("正在加载界面…");
        ShowWindow();
    }

    public static void QuitAll()
    {
        try
        {
            int pid = FindPidByPort(Port);
            if (pid > 0) Process.GetProcessById(pid).Kill();
        }
        catch { }
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

    private static bool Probe(int timeoutMs)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(Url);
            req.Timeout = timeoutMs;
            req.Method = "GET";
            using (var resp = (HttpWebResponse)req.GetResponse())
            {
                return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 400;
            }
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
        var args = "/c \"\"" + node + "\" \"" + bin + "\" web --port " + Port + " >> \"" + log + "\" 2>&1\"";
        var psi = new ProcessStartInfo("cmd.exe", args);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WorkingDirectory = Path.GetDirectoryName(bin);
        ServerCmd = Process.Start(psi);
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
        var candidates = new System.Collections.Generic.List<string>();
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string npxRoot = Path.Combine(local, "npm-cache", "_npx");
        if (Directory.Exists(npxRoot))
        {
            foreach (var dir in Directory.GetDirectories(npxRoot))
            {
                string p = Path.Combine(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
                if (File.Exists(p)) candidates.Add(p);
            }
        }
        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string global = Path.Combine(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
        if (File.Exists(global)) candidates.Add(global);
        if (candidates.Count == 0) return null;
        candidates.Sort((a, b) => File.GetLastWriteTimeUtc(b).CompareTo(File.GetLastWriteTimeUtc(a)));
        return candidates[0];
    }

    private static string FindNode()
    {
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

    private static int FindPidByPort(int port)
    {
        int size = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size, true, 2, 5, 0);
        if (size <= 0) return 0;
        IntPtr buf = Marshal.AllocHGlobal(size);
        try
        {
            if (GetExtendedTcpTable(buf, ref size, true, 2, 5, 0) != 0) return 0;
            int rows = Marshal.ReadInt32(buf);
            IntPtr p = new IntPtr(buf.ToInt64() + 4);
            for (int i = 0; i < rows; i++)
            {
                uint state = (uint)Marshal.ReadInt32(p);
                uint portRaw = (uint)Marshal.ReadInt32(new IntPtr(p.ToInt64() + 8));
                int localPort = (int)(((portRaw & 0xFF00) >> 8) | ((portRaw & 0xFF) << 8));
                int pid = Marshal.ReadInt32(new IntPtr(p.ToInt64() + 20));
                if (state == 2 && localPort == port) return pid;
                p = new IntPtr(p.ToInt64() + 24);
            }
            return 0;
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
        }
    }

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
                    return Icon.FromHandle(small.GetHicon());
                }
            }
        }
        catch { }
        return SystemIcons.Application;
    }

    private static void Fail(string message)
    {
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
                if (e.IsSuccess) _web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                    "(function(){function chk(){var ok=false;try{for(var i=0;i<document.body.children.length;i++){var n=document.body.children[i];if(n.tagName!=='SCRIPT'&&n.tagName!=='STYLE'&&n.getBoundingClientRect().height>50){ok=true;break}}}catch(x){}if(ok){try{window.chrome.webview.postMessage('dsh-ui-ready')}catch(x){}}else{setTimeout(chk,100)}}chk()})();");
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

    public void EnsureNavigated()
    {
        if (_navigated) return;
        _navigated = true;
        try
        {
            _web.Source = new Uri(Program.Url);
        }
        catch
        {
            _navigated = false;
        }
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














