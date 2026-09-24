using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Program
{
    internal const int Port = 3080;
    internal static readonly string Url = LauncherPolicy.Origin(Port) + "/";
    internal static MainForm Form;
    internal static LauncherService Service;
    private static NotifyIcon _tray;
    private static ContextMenuStrip _menu;
    private static Icon _trayIcon;
    private static EventWaitHandle _showEvent;
    private static readonly CancellationTokenSource Lifetime = new CancellationTokenSource();
    private static SynchronizationContext _ui;
    private static Task _healthTask, _alertTask, _showTask, _shutdownTask;
    private static bool _openInFlight;
    private static int _quitting;
    internal static bool IsQuitting { get { return Volatile.Read(ref _quitting) != 0; } }

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    internal static extern uint GetDpiForSystem();

    [STAThread]
    private static void Main()
    {
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch { try { SetProcessDPIAware(); } catch { } }
        bool createdNew;
        using (var mutex = new Mutex(true, @"Local\DeepSeekHarnessTray", out createdNew))
        {
            if (!createdNew)
            {
                try
                {
                    EventWaitHandle existing;
                    if (EventWaitHandle.TryOpenExisting(@"Local\DeepSeekHarnessShow", out existing))
                        using (existing) existing.Set();
                }
                catch (UnauthorizedAccessException) { }
                return;
            }
            Application.EnableVisualStyles();
            var options = new LauncherOptions();
            Service = new LauncherService(options, token => LauncherRuntime.StartInfo(Port, token), null);
            _showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\DeepSeekHarnessShow");
            Form = new MainForm();
            Service.SessionReady += generation => Post(() => Form.OnSessionReady(generation));
            _trayIcon = LoadIcon();
            _menu = new ContextMenuStrip();
            _menu.Items.Add("打开 DeepSeek Harness", null, (s, e) => RequestOpen());
            _menu.Items.Add(new ToolStripSeparator());
            _menu.Items.Add("退出", null, (s, e) => QuitAll());
            _tray = new NotifyIcon { Icon = _trayIcon, Text = "DeepSeek Harness", ContextMenuStrip = _menu, Visible = true };
            _tray.DoubleClick += (s, e) => RequestOpen();
            try { Application.Run(Form); }
            finally
            {
                StopBackground();
                if (_shutdownTask == null) _shutdownTask = Service.ShutdownAsync();
                try { _shutdownTask.GetAwaiter().GetResult(); } catch (Exception error) { Service.Log("shutdown: " + error.GetType().Name); }
                foreach (Task task in new[] { _healthTask, _alertTask, _showTask })
                    if (task != null) try { task.GetAwaiter().GetResult(); } catch (OperationCanceledException) { }
                _tray.Visible = false;
                _tray.Dispose();
                _menu.Dispose();
                _trayIcon.Dispose();
                _showEvent.Dispose();
                Lifetime.Dispose();
            }
        }
    }

    // Called only after the form has a UI-thread-created handle and the message loop exists.
    internal static void UiReady()
    {
        _ui = SynchronizationContext.Current;
        _showTask = Task.Run(() =>
        {
            var handles = new WaitHandle[] { Lifetime.Token.WaitHandle, _showEvent };
            while (WaitHandle.WaitAny(handles) == 1) Post(RequestOpen);
        });
        _healthTask = Task.Run(new Func<Task>(HealthLoopAsync));
        _alertTask = Task.Run(new Func<Task>(AlertLoopAsync));
        RequestOpen();
    }

    internal static void Post(Action action)
    {
        var context = _ui;
        if (context == null || IsQuitting) return;
        try
        {
            context.Post(state =>
            {
                if (IsQuitting || Form == null || Form.IsDisposed || Form.Disposing || !Form.IsHandleCreated) return;
                try { action(); }
                catch (Exception error) { Service.Log("UI callback: " + error.GetType().Name); }
            }, null);
        }
        catch (InvalidOperationException) { }
    }

    internal static async void RequestOpen()
    {
        if (IsQuitting || Form == null || Form.IsDisposed) return;
        Form.ActivateWindow(); // Only an explicit open (including initial launch) may take focus.
        if (_openInFlight) return;
        _openInFlight = true;
        Form.BeginManualOpen();
        try
        {
            ReadyResult result = await Service.EnsureReadyAsync();
            if (IsQuitting || Form.IsDisposed) return;
            if (result.Ready) await Form.NavigateReadyAsync(false);
            else Form.ShowFailure(result.Message + "\n日志：" + Service.LogPath);
        }
        catch (Exception error)
        {
            Service.Log("open failed: " + error.GetType().Name);
            if (!IsQuitting && !Form.IsDisposed) Form.ShowFailure("打开失败（" + error.GetType().Name + "）。\n日志：" + Service.LogPath);
        }
        finally { _openInFlight = false; }
    }

    private static async Task HealthLoopAsync()
    {
        bool notified = false;
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(120), Lifetime.Token).ConfigureAwait(false);
            while (!Lifetime.IsCancellationRequested)
            {
                ReadyResult result = await Service.EnsureReadyAsync().ConfigureAwait(false);
                if (result.Ready) notified = false;
                else if (!notified && !Lifetime.IsCancellationRequested)
                {
                    notified = true;
                    Post(() => Balloon("本地服务尚未恢复；不会重复拉起仍在运行的实例。可从托盘重新打开，日志：" + Service.LogPath, ToolTipIcon.Warning));
                }
                await Task.Delay(TimeSpan.FromSeconds(60), Lifetime.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { Service.Log("health loop stopped: " + error.GetType().Name); }
    }

    private static async Task AlertLoopAsync()
    {
        var ledger = new AlertLedger(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeepSeekHarness", "seen-alerts.txt"), DateTime.Now);
        bool succeeded = false;
        int delay = 3000;
        try
        {
            while (!Lifetime.IsCancellationRequested)
            {
                // Delay is AFTER the previous request, so a slow initial 35s GET cannot overlap.
                await Task.Delay(delay, Lifetime.Token).ConfigureAwait(false);
                try
                {
                    AlertResponse response = await Service.GetAlertsAsync(Lifetime.Token).ConfigureAwait(false);
                    Lifetime.Token.ThrowIfCancellationRequested();
                    if (response.Status == 200 && response.Alerts != null)
                    {
                        succeeded = true;
                        bool changed = false;
                        foreach (LauncherAlert alert in response.Alerts)
                        {
                            if (!ledger.MarkSeen(alert.Key, DateTime.Now)) continue;
                            changed = true;
                            string message = alert.Message;
                            Post(() => Balloon(message, ToolTipIcon.Warning));
                        }
                        if (changed) ledger.Save();
                    }
                    else if (response.Status == 401 || response.Status == 403)
                    {
                        // Re-authenticate through the same single-flight root/token path, never
                        // bypass the plugin's connection.requestRejection guard.
                        await Service.EnsureReadyAsync().ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) { if (Lifetime.IsCancellationRequested) throw; }
                catch (Exception error) { Service.Log("alerts GET skipped: " + error.GetType().Name); }
                delay = succeeded ? 5 * 60 * 1000 : 15000;
            }
        }
        catch (OperationCanceledException) { }
    }

    private static void Balloon(string text, ToolTipIcon icon)
    {
        if (IsQuitting || _tray == null) return;
        try { _tray.ShowBalloonTip(8000, "DeepSeek Harness", text, icon); }
        catch (InvalidOperationException) { }
    }

    internal static void StopBackground()
    {
        if (Interlocked.Exchange(ref _quitting, 1) != 0) return;
        Lifetime.Cancel();
        if (Service != null) Service.RequestStop();
    }

    private static async void QuitAll()
    {
        if (IsQuitting) return;
        StopBackground();
        _tray.Visible = false;
        Form.PrepareForExit();
        try
        {
            _shutdownTask = Service.ShutdownAsync();
            await Task.WhenAll(_shutdownTask, _healthTask ?? Task.FromResult(0), _alertTask ?? Task.FromResult(0), _showTask ?? Task.FromResult(0));
        }
        catch (Exception error) { Service.Log("exit cleanup: " + error.GetType().Name); }
        finally { if (!Form.IsDisposed) { Form.ReallyExit = true; Form.Close(); } }
    }

    internal static Icon LoadIcon()
    {
        try
        {
            string png = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "icon.png");
            if (File.Exists(png))
                using (var bitmap = new Bitmap(png))
                using (var small = new Bitmap(bitmap, 32, 32))
                {
                    IntPtr handle = small.GetHicon();
                    try { return (Icon)Icon.FromHandle(handle).Clone(); }
                    finally { DestroyIcon(handle); }
                }
        }
        catch (Exception) { }
        return (Icon)SystemIcons.Application.Clone();
    }
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr icon);
}

internal sealed class MainForm : Form
{
    internal bool ReallyExit;
    private readonly WebView2 _web;
    private readonly RetryBudget _heal = new RetryBudget(5);
    private readonly System.Windows.Forms.Timer _healTimer = new System.Windows.Forms.Timer();
    private readonly System.Windows.Forms.Timer _paintTimer = new System.Windows.Forms.Timer();
    private Task<bool> _initialization;
    private bool _closing, _navigating, _navigated, _needsNavigation = true;
    private bool _documentOk, _painted, _rendered;
    private long _appliedGeneration;
    private ulong _navigationId;
    private Panel _splash;
    private PictureBox _splashPic;
    private Label _splashLabel;

    internal MainForm()
    {
        Text = "DeepSeek Harness";
        Icon = Program.LoadIcon();
        ShowIcon = true;
        StartPosition = FormStartPosition.CenterScreen;
        float scale = 1f;
        try { uint dpi = Program.GetDpiForSystem(); if (dpi > 0) scale = dpi / 96f; } catch { }
        var area = Screen.PrimaryScreen.WorkingArea;
        Size = new Size(Math.Max(760, (int)Math.Min(1280 * scale, area.Width * 0.86)), Math.Max(500, (int)Math.Min(840 * scale, area.Height * 0.88)));
        MinimumSize = new Size((int)(640 * scale), (int)(420 * scale));
        BackColor = Color.White;
        _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.White };
        Controls.Add(_web);
        BuildSplash();
        _healTimer.Tick += HealTick;
        _paintTimer.Interval = 20000;
        _paintTimer.Tick += (s, e) =>
        {
            _paintTimer.Stop();
            if (!_rendered) SetStatus("服务已连接，界面仍在加载。可从托盘重新打开重试。", true);
        };
        Shown += (s, e) => Program.UiReady();
    }

    private async Task<bool> InitializeWebAsync()
    {
        try
        {
            await _web.EnsureCoreWebView2Async();
            if (_closing || IsDisposed || Program.IsQuitting) return false;
            var core = _web.CoreWebView2;
            core.NavigationStarting += NavigationStarting;
            core.NewWindowRequested += (s, e) =>
            {
                e.Handled = true;
                if (_closing || Program.IsQuitting || !e.IsUserInitiated) return;
                Uri local;
                if (LauncherPolicy.TryLocalUri(e.Uri, Program.Port, out local)) { core.Navigate(local.AbsoluteUri); return; }
                OpenExternal(e.Uri, e.IsUserInitiated, false);
            };
            core.NavigationCompleted += (s, e) =>
            {
                if (_closing || Program.IsQuitting || e.NavigationId != _navigationId) return;
                // WebView reports transport success even for HTTP 401/404/500.
                _documentOk = e.IsSuccess && e.HttpStatusCode == 200;
                if (!_documentOk)
                {
                    Program.Service.Log("navigation failed: http=" + e.HttpStatusCode + " webError=" + e.WebErrorStatus);
                    ScheduleSelfHeal();
                    return;
                }
                FinishPaint();
            };
            core.WebMessageReceived += (s, e) =>
            {
                if (_closing || Program.IsQuitting) return;
                try
                {
                    Uri source;
                    if (LauncherPolicy.TryLocalUri(e.Source, Program.Port, out source)
                        && string.Equals(e.Source, core.Source, StringComparison.Ordinal)
                        && e.TryGetWebMessageAsString() == "dsh-ui-ready")
                    { _painted = true; FinishPaint(); }
                }
                catch (ArgumentException) { }
            };
#if !DEBUG
            core.Settings.AreDevToolsEnabled = false;
#endif
            // Bounded top-document paint detection. HTTP readiness alone does not dismiss splash.
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                "(function(){if(window.top!==window)return;var tries=0;function chk(){var ok=false;try{if(document.body)for(var i=0;i<document.body.children.length;i++){var n=document.body.children[i];if(n.tagName!=='SCRIPT'&&n.tagName!=='STYLE'&&n.getBoundingClientRect().height>50){ok=true;break}}}catch(x){}if(ok){try{window.chrome.webview.postMessage('dsh-ui-ready')}catch(x){}}else if(++tries<300){setTimeout(chk,100)}}chk()})();");
            return !_closing && !Program.IsQuitting;
        }
        catch (Exception error)
        {
            Program.Service.Log("WebView2 initialization: " + error.GetType().Name);
            if (!_closing && !Program.IsQuitting) ShowFailure("WebView2 未能初始化，请确认已安装 Microsoft Edge WebView2 Runtime。\n日志：" + Program.Service.LogPath);
            _initialization = null;
            return false;
        }
    }

    private void NavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (_closing || Program.IsQuitting) { e.Cancel = true; return; }
        Uri local;
        if (LauncherPolicy.TryLocalUri(e.Uri, Program.Port, out local))
        {
            _navigationId = e.NavigationId;
            _documentOk = false;
            _painted = false;
            _rendered = false;
            SetStatus("正在加载界面…", true);
            _paintTimer.Stop();
            _paintTimer.Start();
            return;
        }
        // about/data/file/custom schemes from web content are not trusted native error pages.
        if (e.Uri == "about:blank" && !_navigated && !e.IsUserInitiated) return;
        e.Cancel = true;
        OpenExternal(e.Uri, e.IsUserInitiated, e.IsRedirected);
    }

    private static void OpenExternal(string value, bool userInitiated, bool redirected)
    {
        Uri uri;
        if (!LauncherPolicy.TryExternalUri(value, userInitiated, redirected, Program.Port, out uri)) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception error) { Program.Service.Log("external browser failed: " + error.GetType().Name); }
    }

    internal void BeginManualOpen()
    {
        _healTimer.Stop();
        _heal.Reset();
        if (!_rendered) SetStatus("正在检查本地服务…", true);
    }

    internal async void OnSessionReady(long generation)
    {
        if (_closing || Program.IsQuitting) return;
        if (generation != _appliedGeneration) _needsNavigation = true;
        if (!Visible) return; // Remember invalidation; next manual open will navigate.
        try { await NavigateReadyAsync(false); }
        catch (Exception error) { Program.Service.Log("session navigation: " + error.GetType().Name); }
    }

    internal async Task NavigateReadyAsync(bool force)
    {
        if (_closing || Program.IsQuitting) return;
        if (force) _needsNavigation = true;
        if (!Visible || _navigating) return;
        _navigating = true;
        try
        {
            if (_initialization == null) _initialization = InitializeWebAsync();
            if (!await _initialization || _closing || Program.IsQuitting) return;
            if (!Visible) { _needsNavigation = true; return; }
            BrowserSession session = Program.Service.BrowserCookies();
            if (session == null) { _needsNavigation = true; return; }
            if (_navigated && !_needsNavigation && session.Generation == _appliedGeneration && _rendered) return;
            var manager = _web.CoreWebView2.CookieManager;
            foreach (Cookie cookie in session.Cookies)
            {
                var browserCookie = manager.CreateCookie(cookie.Name, cookie.Value, cookie.Domain, cookie.Path);
                browserCookie.IsHttpOnly = cookie.HttpOnly;
                browserCookie.IsSecure = cookie.Secure;
                browserCookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
                if (cookie.Expires != DateTime.MinValue) browserCookie.Expires = cookie.Expires.ToUniversalTime();
                manager.AddOrUpdateCookie(browserCookie);
            }
            _needsNavigation = false;
            _navigated = true;
            _appliedGeneration = session.Generation;
            Program.Service.Log("navigate clean local root; session=" + session.Generation);
            _web.CoreWebView2.Navigate(Program.Url);
        }
        catch (Exception error)
        {
            _needsNavigation = true;
            Program.Service.Log("navigate failed: " + error.GetType().Name);
            ScheduleSelfHeal();
        }
        finally { _navigating = false; }
    }

    private void FinishPaint()
    {
        if (!_documentOk || !_painted || _closing || Program.IsQuitting) return;
        _rendered = true;
        _healTimer.Stop();
        _heal.Reset();
        _paintTimer.Stop();
        _splash.Visible = false;
        // Do not Show/Activate here: delayed paint must not restore a user-hidden window.
    }

    private void ScheduleSelfHeal()
    {
        _needsNavigation = true;
        if (_closing || Program.IsQuitting || !Visible) return;
        int delay;
        if (!_heal.TrySchedule(out delay))
        {
            if (!_heal.Pending) ShowFailure("界面重试已达到上限，可从托盘重新打开。\n日志：" + Program.Service.LogPath);
            return;
        }
        _paintTimer.Stop();
        SetStatus("界面未就绪，正在恢复本地会话（" + _heal.Attempts + "/5）…", true);
        _healTimer.Interval = delay;
        _healTimer.Start();
    }

    private async void HealTick(object sender, EventArgs e)
    {
        _healTimer.Stop();
        bool retry = false;
        try
        {
            if (_closing || Program.IsQuitting || !Visible) return;
            ReadyResult result = await Program.Service.EnsureReadyAsync();
            if (_closing || Program.IsQuitting || !Visible) return;
            if (result.Ready) await NavigateReadyAsync(true);
            else { SetStatus(result.Message, true); retry = true; }
        }
        catch (Exception error) { Program.Service.Log("navigation recovery: " + error.GetType().Name); retry = true; }
        finally { _heal.CompleteAttempt(); }
        if (retry && !_closing && !Program.IsQuitting) ScheduleSelfHeal();
    }

    private void BuildSplash()
    {
        _splash = new Panel { Dock = DockStyle.Fill, BackColor = Color.White };
        _splashPic = new PictureBox { SizeMode = PictureBoxSizeMode.Zoom, Size = new Size(110, 110) };
        try
        {
            string png = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "icon.png");
            if (File.Exists(png)) _splashPic.Image = new Bitmap(png);
        }
        catch (Exception) { }
        _splashLabel = new Label
        {
            Text = "DeepSeek Harness 正在启动服务…", AutoSize = true,
            ForeColor = Color.FromArgb(70, 70, 80), Font = new Font("Segoe UI", 11f), TextAlign = ContentAlignment.MiddleCenter
        };
        _splash.Controls.Add(_splashPic);
        _splash.Controls.Add(_splashLabel);
        Controls.Add(_splash);
        _splash.BringToFront();
        _splash.Resize += (s, e) => CenterSplash();
        CenterSplash();
    }

    private void CenterSplash()
    {
        if (_splash == null) return;
        _splashLabel.MaximumSize = new Size(Math.Max(200, _splash.ClientSize.Width - 80), 0);
        _splashPic.Left = (_splash.ClientSize.Width - _splashPic.Width) / 2;
        _splashPic.Top = Math.Max(20, (_splash.ClientSize.Height - _splashPic.Height - _splashLabel.Height - 24) / 2);
        _splashLabel.Left = (_splash.ClientSize.Width - _splashLabel.Width) / 2;
        _splashLabel.Top = _splashPic.Top + _splashPic.Height + 24;
    }
    private void SetStatus(string text, bool show)
    {
        if (_closing || IsDisposed) return;
        _splashLabel.Text = text;
        if (show) { _splash.Visible = true; _splash.BringToFront(); }
        CenterSplash();
    }
    internal void ShowFailure(string reason)
    {
        if (_closing || Program.IsQuitting) return;
        _paintTimer.Stop();
        _needsNavigation = true;
        _rendered = false;
        Program.Service.Log("open not ready: " + reason);
        SetStatus(reason, true); // Native error UI, not navigable data: HTML.
    }
    internal void ActivateWindow()
    {
        if (_closing || Program.IsQuitting) return;
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
    }
    internal void PrepareForExit()
    {
        if (_closing) return;
        _closing = true;
        _healTimer.Stop();
        _paintTimer.Stop();
        _heal.CompleteAttempt();
    }
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!ReallyExit && e.CloseReason != CloseReason.WindowsShutDown && e.CloseReason != CloseReason.TaskManagerClosing)
        {
            e.Cancel = true;
            _healTimer.Stop();
            _paintTimer.Stop();
            _heal.CompleteAttempt();
            Hide();
            return;
        }
        PrepareForExit();
        Program.StopBackground();
        base.OnFormClosing(e);
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            PrepareForExit();
            _healTimer.Dispose();
            _paintTimer.Dispose();
            if (_splashPic != null && _splashPic.Image != null) { _splashPic.Image.Dispose(); _splashPic.Image = null; }
            if (Icon != null) { Icon.Dispose(); Icon = null; }
        }
        base.Dispose(disposing);
    }
}
