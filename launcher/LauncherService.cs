using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal sealed class LauncherOptions
{
    internal int Port = 3080;
    internal TimeSpan ReadyTimeout = TimeSpan.FromSeconds(120);
    internal TimeSpan RequestTimeout = TimeSpan.FromSeconds(35);
    internal TimeSpan PollInterval = TimeSpan.FromMilliseconds(500);
    internal int MaximumStarts = 2;
    internal bool AllowStart = true;
    internal bool PersistState = true;
    internal string LogDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
    internal string StateDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DeepSeekHarness");
}

internal sealed class ReadyResult
{
    internal readonly bool Ready;
    internal readonly bool Online;
    internal readonly int HttpStatus;
    internal readonly long Generation;
    internal readonly string Message;
    internal ReadyResult(bool ready, bool online, int status, long generation, string message)
    { Ready = ready; Online = online; HttpStatus = status; Generation = generation; Message = message; }
}

internal sealed class HttpObservation
{
    internal bool Online;
    internal bool Ready;
    internal int Status;
    internal string Detail;
}

internal sealed class AlertResponse
{
    internal int Status;
    internal List<LauncherAlert> Alerts;
}

internal sealed class BrowserSession
{
    internal long Generation;
    internal Cookie[] Cookies;
}

// One CookieContainer belongs to one candidate validation. A previously authenticated
// cookie must not make a stale token appear valid. After validation this same client
// is retained for root health checks and the authenticated alerts GET.
internal sealed class LocalSession : IDisposable
{
    private readonly int _port;
    private readonly TimeSpan _timeout;
    private readonly CookieContainer _cookies;
    private readonly HttpClient _client;
    private int _references = 1;
    internal LocalSession(int port, TimeSpan timeout)
    {
        _port = port;
        _timeout = timeout;
        _cookies = new CookieContainer();
        var handler = new HttpClientHandler
        {
            CookieContainer = _cookies,
            UseCookies = true,
            UseProxy = false,
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
        };
        _client = new HttpClient(handler) { Timeout = timeout };
    }
    internal void Retain() { Interlocked.Increment(ref _references); }
    public void Dispose() { if (Interlocked.Decrement(ref _references) == 0) _client.Dispose(); }

    internal Cookie[] SnapshotCookies()
    {
        var result = new List<Cookie>();
        foreach (Cookie cookie in _cookies.GetCookies(new Uri(LauncherPolicy.Origin(_port) + "/")))
            result.Add(new Cookie(cookie.Name, cookie.Value, cookie.Path, cookie.Domain)
            { HttpOnly = cookie.HttpOnly, Secure = cookie.Secure, Expires = cookie.Expires });
        return result.ToArray();
    }

    internal async Task<HttpObservation> ProbeAsync(string candidate, CancellationToken cancellation)
    {
        Uri current;
        if (candidate == null) current = new Uri(LauncherPolicy.Origin(_port) + "/");
        else if (!LauncherPolicy.TryTokenUrl(candidate, _port, out current))
            return new HttpObservation { Detail = "invalid_candidate" };
        var result = new HttpObservation { Detail = "offline" };
        using (var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
        {
            budget.CancelAfter(_timeout);
            try
            {
                // Fixed redirect bound. Only clean same-origin root can receive the cookie.
                for (int step = 0; step < 3; step++)
                {
                    using (var request = new HttpRequestMessage(HttpMethod.Get, current))
                    {
                        request.Headers.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue { NoCache = true };
                        using (var response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, budget.Token).ConfigureAwait(false))
                        using (budget.Token.Register(response.Dispose))
                        {
                            result.Online = true;
                            result.Status = (int)response.StatusCode;
                            if (result.Status == 301 || result.Status == 302 || result.Status == 303 || result.Status == 307 || result.Status == 308)
                            {
                                Uri target;
                                if (!LauncherPolicy.TryRootRedirect(current, response.Headers.Location, _port, out target))
                                { result.Detail = "blocked_redirect"; return result; }
                                current = target;
                                continue;
                            }
                            if (result.Status != 200) { result.Detail = "http_" + result.Status; return result; }
                            if (!LauncherPolicy.IsCleanRoot(current, _port))
                            {
                                // Older servers may return 200 on the token URL. Still require
                                // a subsequent clean-root GET with the obtained cookie.
                                current = new Uri(LauncherPolicy.Origin(_port) + "/");
                                continue;
                            }
                            string media = response.Content.Headers.ContentType == null ? "" : response.Content.Headers.ContentType.MediaType;
                            string prefix = await ReadBodyAsync(response.Content, 4096, true, budget.Token).ConfigureAwait(false);
                            result.Ready = LauncherPolicy.IsHtmlReady(result.Status, media, prefix);
                            result.Detail = result.Ready ? "html_ready" : "not_html";
                            return result;
                        }
                    }
                }
                result.Detail = "redirect_limit";
            }
            catch (OperationCanceledException) { cancellation.ThrowIfCancellationRequested(); result.Detail = "request_timeout"; }
            catch (HttpRequestException) { result.Detail = "connection_failed"; }
            catch (IOException) { result.Detail = "response_incomplete"; }
            catch (ObjectDisposedException) { cancellation.ThrowIfCancellationRequested(); result.Detail = "request_timeout"; }
            return result;
        }
    }

    internal async Task<AlertResponse> GetAlertsAsync(CancellationToken cancellation)
    {
        using (var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
        {
            budget.CancelAfter(_timeout);
            using (var request = new HttpRequestMessage(HttpMethod.Get, LauncherPolicy.Origin(_port) + "/balance-card/alerts"))
            using (var response = await _client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, budget.Token).ConfigureAwait(false))
            using (budget.Token.Register(response.Dispose))
            {
                var result = new AlertResponse { Status = (int)response.StatusCode };
                if (result.Status == 200)
                {
                    string body = await ReadBodyAsync(response.Content, 128 * 1024, false, budget.Token).ConfigureAwait(false);
                    result.Alerts = LauncherPolicy.ParseAlerts(body);
                }
                return result;
            }
        }
    }

    private static async Task<string> ReadBodyAsync(HttpContent content, int maximum, bool prefixOnly, CancellationToken cancellation)
    {
        using (var stream = await content.ReadAsStreamAsync().ConfigureAwait(false))
        {
            byte[] buffer = new byte[maximum + (prefixOnly ? 0 : 1)];
            int size = 0;
            while (size < buffer.Length)
            {
                int count = await stream.ReadAsync(buffer, size, buffer.Length - size, cancellation).ConfigureAwait(false);
                if (count == 0) break;
                size += count;
            }
            if (size > maximum) throw new FormatException("Response exceeds local size limit");
            return Encoding.UTF8.GetString(buffer, 0, size);
        }
    }
}

internal sealed class PortSnapshot
{
    internal bool Known;
    internal bool Listening;
    internal int Pid;
    internal long StartTicks;
}

internal static class LocalPortInspector
{
    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);

    internal static PortSnapshot Read(int port)
    {
        IntPtr table = IntPtr.Zero;
        try
        {
            int size = 0;
            uint code = GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0); // AF_INET, OWNER_PID_LISTENER
            if ((code != 0 && code != 122) || size < 4 || size > 16 * 1024 * 1024) return new PortSnapshot();
            table = Marshal.AllocHGlobal(size);
            code = GetExtendedTcpTable(table, ref size, false, 2, 3, 0);
            if (code != 0) return new PortSnapshot();
            int count = Marshal.ReadInt32(table);
            if (count < 0 || count > (size - 4) / 24) return new PortSnapshot();
            for (int i = 0; i < count; i++)
            {
                int offset = 4 + i * 24;
                uint address = unchecked((uint)Marshal.ReadInt32(table, offset + 4));
                int localPort = (Marshal.ReadByte(table, offset + 8) << 8) | Marshal.ReadByte(table, offset + 9);
                if (localPort != port || (address != 0 && address != 0x0100007f)) continue;
                int pid = Marshal.ReadInt32(table, offset + 20);
                long ticks = 0;
                try { using (var process = Process.GetProcessById(pid)) ticks = process.StartTime.ToUniversalTime().Ticks; } catch (ArgumentException) { } catch (System.ComponentModel.Win32Exception) { } catch (InvalidOperationException) { }
                return new PortSnapshot { Known = true, Listening = true, Pid = pid, StartTicks = ticks };
            }
            return new PortSnapshot { Known = true };
        }
        catch (DllNotFoundException) { return new PortSnapshot(); }
        catch (EntryPointNotFoundException) { return new PortSnapshot(); }
        finally { if (table != IntPtr.Zero) Marshal.FreeHGlobal(table); }
    }
}

internal sealed class TokenRecord
{
    public int Version { get; set; }
    public int Port { get; set; }
    public int Pid { get; set; }
    public long StartTicks { get; set; }
    public string Url { get; set; }
}

internal sealed class TokenStore
{
    private readonly string _path;
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("DSH Desktop local token v1");
    internal TokenStore(string path) { _path = path; }
    internal string Read(int port, PortSnapshot live)
    {
        if (!live.Known || !live.Listening || live.Pid <= 0 || live.StartTicks <= 0) return null;
        try
        {
            if (!File.Exists(_path) || new FileInfo(_path).Length > 16 * 1024) return null;
            byte[] encrypted = Convert.FromBase64String(File.ReadAllText(_path, Encoding.UTF8));
            byte[] bytes = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
            TokenRecord record;
            try { record = new JavaScriptSerializer().Deserialize<TokenRecord>(Encoding.UTF8.GetString(bytes)); }
            finally { Array.Clear(bytes, 0, bytes.Length); }
            Uri uri;
            if (record == null || record.Version != 1 || record.Port != port || record.Pid != live.Pid
                || record.StartTicks != live.StartTicks || !LauncherPolicy.TryTokenUrl(record.Url, port, out uri)) return null;
            return record.Url;
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (CryptographicException) { }
        catch (FormatException) { }
        catch (ArgumentException) { }
        catch (InvalidOperationException) { }
        return null;
    }
    internal void Save(int port, PortSnapshot live, string url)
    {
        Uri uri;
        if (!live.Known || !live.Listening || live.Pid <= 0 || live.StartTicks <= 0 || !LauncherPolicy.TryTokenUrl(url, port, out uri)) return;
        byte[] bytes = null;
        try
        {
            bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(new TokenRecord
            { Version = 1, Port = port, Pid = live.Pid, StartTicks = live.StartTicks, Url = url }));
            byte[] protectedBytes = ProtectedData.Protect(bytes, Entropy, DataProtectionScope.CurrentUser);
            // Created under LocalAppData, inheriting the user's directory ACL; no global ACL grants.
            LauncherFiles.AtomicWrite(_path, Convert.ToBase64String(protectedBytes));
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (CryptographicException) { }
        finally { if (bytes != null) Array.Clear(bytes, 0, bytes.Length); }
    }
}

internal sealed class LauncherService
{
    private readonly LauncherOptions _options;
    private readonly Func<CancellationToken, ProcessStartInfo> _startInfo;
    private readonly Func<PortSnapshot> _inspectPort;
    private readonly object _lifecycle = new object();
    private readonly object _sessionSync = new object();
    private readonly AsyncSingleFlight<ReadyResult> _singleFlight = new AsyncSingleFlight<ReadyResult>();
    private readonly CancellationTokenSource _stop = new CancellationTokenSource();
    private readonly LauncherLog _log;
    private readonly LauncherLog _serverLog;
    private readonly TokenStore _tokens;
    private readonly List<string> _captured = new List<string>();
    private LocalSession _session;
    private Process _owned;
    private long _generation;
    private int _stopping;
    private string _exitReason;
    internal event Action<long> SessionReady;
    internal string LogPath { get { return Path.Combine(_options.LogDirectory, "launcher.log"); } }
    internal string ServerLogPath { get { return Path.Combine(_options.LogDirectory, "web-server.log"); } }
    internal bool IsStopping { get { return Volatile.Read(ref _stopping) != 0; } }

    internal LauncherService(LauncherOptions options, Func<CancellationToken, ProcessStartInfo> startInfo, Func<PortSnapshot> inspectPort)
    {
        _options = options;
        _startInfo = startInfo;
        _inspectPort = inspectPort ?? (() => LocalPortInspector.Read(options.Port));
        _log = new LauncherLog(LogPath, 2 * 1024 * 1024);
        _serverLog = new LauncherLog(ServerLogPath, 5 * 1024 * 1024);
        _tokens = new TokenStore(Path.Combine(options.StateDirectory, "launcher-auth.dat"));
    }

    internal void Log(string text) { _log.Write(text); }
    internal Task<ReadyResult> EnsureReadyAsync()
    {
        if (IsStopping) return Task.FromResult(Failure(false, 0, "启动器正在退出。"));
        return _singleFlight.Run(EnsureCoreAsync);
    }

    private async Task<ReadyResult> EnsureCoreAsync()
    {
        int starts = 0;
        bool online = false;
        int status = 0;
        var rejected = new HashSet<string>(StringComparer.Ordinal);
        using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token))
        {
            deadline.CancelAfter(_options.ReadyTimeout);
            try
            {
                while (true)
                {
                    deadline.Token.ThrowIfCancellationRequested();
                    var existing = AcquireSession();
                    if (existing != null)
                    {
                        HttpObservation check;
                        try { check = await existing.ProbeAsync(null, deadline.Token).ConfigureAwait(false); }
                        finally { existing.Dispose(); }
                        if (check.Ready) return Success();
                        DropSession();
                        Log("session no longer ready: " + check.Detail);
                    }

                    var plain = new LocalSession(_options.Port, _options.RequestTimeout);
                    HttpObservation observation;
                    bool adopted = false;
                    try
                    {
                        observation = await plain.ProbeAsync(null, deadline.Token).ConfigureAwait(false);
                        if (observation.Ready) { Adopt(plain); adopted = true; return Success(); }
                    }
                    finally { if (!adopted) plain.Dispose(); }
                    var live = _inspectPort();
                    online = observation.Online || live.Listening;
                    status = observation.Status;

                    // A missing/mounting root and an authentication challenge are both online,
                    // never grounds for starting a second node. Try only exact local candidates.
                    if (online)
                    {
                        foreach (string candidate in Candidates(live))
                        {
                            if (rejected.Contains(candidate)) continue;
                            var validation = new LocalSession(_options.Port, _options.RequestTimeout);
                            adopted = false;
                            try
                            {
                                var check = await validation.ProbeAsync(candidate, deadline.Token).ConfigureAwait(false);
                                if (check.Ready)
                                {
                                    // Bind persisted candidates to a still-live listener, not just historical output.
                                    var after = _inspectPort();
                                    if (live.Known && after.Known && (live.Pid != after.Pid || live.StartTicks != after.StartTicks)) continue;
                                    Adopt(validation);
                                    adopted = true;
                                    if (_options.PersistState) _tokens.Save(_options.Port, after, candidate);
                                    Log("local token exchange verified; root HTTP 200 HTML");
                                    return Success();
                                }
                                if (check.Status == 401 || check.Status == 403) rejected.Add(candidate);
                            }
                            finally { if (!adopted) validation.Dispose(); }
                        }
                    }

                    bool ownedAlive = OwnedAlive();
                    if (_options.AllowStart && LauncherPolicy.CanStart(IsStopping, ownedAlive, online, live.Known, starts, _options.MaximumStarts))
                    {
                        if (StartOwned(deadline.Token)) { starts++; rejected.Clear(); }
                    }
                    else if (!ownedAlive && !online && live.Known && starts >= _options.MaximumStarts)
                        return Failure(false, status, "dsh web 启动后退出，已达到本轮重试上限。" + ExitReason());
                    else if (!ownedAlive && online && (status == 401 || status == 403))
                        return Failure(true, status, "服务在线但本地会话认证未通过。未启动第二个实例；请确认正在运行的 dsh 使用此端口与当前用户配置。" );
                    else if (!_options.AllowStart)
                        return Failure(online, status, online ? "服务在线，但根路径尚未返回已认证的 HTML 200。" : "此端口未就绪；只读诊断不会启动服务。" );
                    else if (!live.Known && !online && !ownedAlive)
                        return Failure(false, status, "无法确认本地端口占用情况；为避免重复启动，本次未拉起服务。" );

                    await Task.Delay(_options.PollInterval, deadline.Token).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                if (IsStopping) return Failure(online, status, "启动器正在退出。" );
                return Failure(online || OwnedAlive(), status, "等待 dsh web 就绪超时；仍存活的进程不会被重复启动。" + ExitReason());
            }
            catch (Exception error)
            {
                // No raw URL, response body, Cookie or exception text is safe to log here.
                Log("readiness failure: " + error.GetType().Name);
                return Failure(online, status, "无法完成本地服务检查（" + error.GetType().Name + "）。" + ExitReason());
            }
        }
    }

    private List<string> Candidates(PortSnapshot live)
    {
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        lock (_lifecycle)
            if (ProcessAlive(_owned)) foreach (string url in _captured) if (seen.Add(url)) result.Add(url);
        string stored = _tokens.Read(_options.Port, live);
        if (stored != null && seen.Add(stored)) result.Add(stored);
        foreach (string path in new[] { ServerLogPath, ServerLogPath + ".old" })
        {
            if (result.Count >= LauncherPolicy.MaxCandidates) break;
            try
            {
                foreach (string url in LauncherPolicy.ExtractTokenUrls(LauncherPolicy.ReadTail(path, LauncherPolicy.MaxLogTailBytes), _options.Port, LauncherPolicy.MaxCandidates))
                {
                    if (seen.Add(url)) result.Add(url);
                    if (result.Count == LauncherPolicy.MaxCandidates) break;
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        return result;
    }

    private bool StartOwned(CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        ProcessStartInfo info = _startInfo(cancellation);
        if (info == null) throw new InvalidOperationException("No compatible local runtime");
        lock (_lifecycle)
        {
            cancellation.ThrowIfCancellationRequested();
            if (IsStopping || ProcessAlive(_owned)) return false;
            var live = _inspectPort();
            if (!live.Known || live.Listening) return false;
            if (_owned != null) { _owned.Dispose(); _owned = null; }
            _captured.Clear();
            _exitReason = null;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            var process = new Process { StartInfo = info };
            process.OutputDataReceived += (sender, args) => CaptureOutput(process, args.Data);
            process.ErrorDataReceived += (sender, args) => CaptureOutput(process, args.Data);
            process.Exited += (sender, args) => RecordExit(process);
            try
            {
                if (!process.Start()) throw new InvalidOperationException("Process did not start");
                _owned = process;
                process.EnableRaisingEvents = true;
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                Log("started owned server pid=" + process.Id + "; awaiting authenticated HTML");
                return true;
            }
            catch
            {
                // It may have started before a redirected-stream failure. Keep ownership until shutdown.
                if (!ReferenceEquals(_owned, process)) process.Dispose();
                throw;
            }
        }
    }

    private void CaptureOutput(Process process, string line)
    {
        if (line == null) return;
        try
        {
            lock (_lifecycle)
            {
                if (!IsStopping && ReferenceEquals(_owned, process) && ProcessAlive(process))
                    foreach (string candidate in LauncherPolicy.ExtractTokenUrls(line, _options.Port, LauncherPolicy.MaxCandidates))
                    {
                        _captured.Remove(candidate);
                        _captured.Insert(0, candidate);
                        if (_captured.Count > LauncherPolicy.MaxCandidates) _captured.RemoveAt(_captured.Count - 1);
                    }
            }
            _serverLog.Write(line);
        }
        catch (Exception error) { Log("child output handling failed: " + error.GetType().Name); }
    }

    private void RecordExit(Process process)
    {
        try
        {
            string reason = "pid=" + process.Id + " exitCode=" + process.ExitCode;
            lock (_lifecycle) if (ReferenceEquals(_owned, process)) _exitReason = reason;
            Log("owned server exited: " + reason + (IsStopping ? " (launcher shutdown)" : " (unexpected)"));
            _serverLog.Write("owned server exited: " + reason);
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }
    private string ExitReason() { lock (_lifecycle) return _exitReason == null ? "" : " " + _exitReason; }
    private static bool ProcessAlive(Process process)
    {
        try { return process != null && !process.HasExited; }
        catch (InvalidOperationException) { return false; }
        catch (System.ComponentModel.Win32Exception) { return true; } // Unknown is not permission to launch a duplicate.
    }
    private bool OwnedAlive() { lock (_lifecycle) return ProcessAlive(_owned); }

    private LocalSession AcquireSession()
    {
        lock (_sessionSync)
        {
            if (IsStopping || _session == null) return null;
            _session.Retain();
            return _session;
        }
    }
    private void DropSession()
    {
        LocalSession old;
        lock (_sessionSync) { old = _session; _session = null; }
        if (old != null) old.Dispose();
    }
    private void Adopt(LocalSession session)
    {
        LocalSession old;
        long generation;
        lock (_sessionSync)
        {
            _stop.Token.ThrowIfCancellationRequested();
            old = _session;
            _session = session;
            generation = ++_generation;
        }
        if (old != null) old.Dispose();
        var handler = SessionReady;
        if (handler != null) handler(generation);
    }
    private ReadyResult Success()
    {
        lock (_sessionSync) return new ReadyResult(true, true, 200, _generation, "界面已就绪。");
    }
    private ReadyResult Failure(bool online, int status, string message)
    { return new ReadyResult(false, online, status, 0, message); }

    internal BrowserSession BrowserCookies()
    {
        lock (_sessionSync)
        {
            if (IsStopping || _session == null) return null;
            return new BrowserSession { Generation = _generation, Cookies = _session.SnapshotCookies() };
        }
    }
    internal async Task<AlertResponse> GetAlertsAsync(CancellationToken cancellation)
    {
        var session = AcquireSession();
        if (session == null) return new AlertResponse { Status = 0 };
        try { return await session.GetAlertsAsync(cancellation).ConfigureAwait(false); }
        finally { session.Dispose(); }
    }
    internal void RequestStop()
    {
        Process owned;
        lock (_lifecycle)
        {
            if (Interlocked.Exchange(ref _stopping, 1) != 0) return;
            owned = _owned;
        }
        _stop.Cancel();
        // This Process is created and retained by this launcher. Never kill by process name/port,
        // never take ownership merely because a PID was found in the private state file.
        try { if (ProcessAlive(owned)) owned.Kill(); }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { Log("could not stop owned server"); }
    }
    internal async Task ShutdownAsync()
    {
        RequestStop();
        var flight = _singleFlight.Current;
        if (flight != null) { try { await flight.ConfigureAwait(false); } catch (OperationCanceledException) { } }
        DropSession();
        Process owned;
        lock (_lifecycle) { owned = _owned; _owned = null; _captured.Clear(); }
        if (owned != null)
        {
            // A bounded wait off the UI thread also gives redirected exit output time to drain.
            await Task.Run(() => { try { owned.WaitForExit(1500); } catch (InvalidOperationException) { } finally { owned.Dispose(); } }).ConfigureAwait(false);
        }
        _stop.Dispose();
    }
}

internal static class LauncherRuntime
{
    internal static ProcessStartInfo StartInfo(int port, CancellationToken cancellation)
    {
        string bin = FindDshBin();
        if (bin == null) throw new FileNotFoundException("No local dsh installation");
        string node = FindNode(cancellation);
        if (node == null) throw new FileNotFoundException("No compatible Node runtime with import.meta.main");
        return new ProcessStartInfo(node, "\"" + bin + "\" web --no-open --port " + port.ToString(CultureInfo.InvariantCulture))
        { WorkingDirectory = Path.GetDirectoryName(bin) };
    }

    internal static string FindDshBin()
    {
        string global = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
        if (File.Exists(global)) return global;
        string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "npm-cache", "_npx");
        string best = null;
        SemanticVersion bestVersion = null;
        DateTime bestTime = DateTime.MinValue;
        try
        {
            foreach (string dir in Directory.EnumerateDirectories(root))
            {
                string package = Path.Combine(dir, "node_modules", "@deepseek-ai", "dsh");
                string path = Path.Combine(package, "lib", "bin.js");
                if (!File.Exists(path)) continue;
                var version = ReadPackageVersion(Path.Combine(package, "package.json"));
                DateTime time = File.GetLastWriteTimeUtc(path);
                bool better = best == null || (version != null && (bestVersion == null || version.CompareTo(bestVersion) > 0))
                    || ((version == null && bestVersion == null || version != null && bestVersion != null && version.CompareTo(bestVersion) == 0) && time > bestTime);
                if (better) { best = path; bestVersion = version; bestTime = time; }
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return best;
    }
    internal static SemanticVersion ReadPackageVersion(string path)
    {
        try
        {
            if (new FileInfo(path).Length > 1024 * 1024) return null;
            var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
            object value;
            return data != null && data.TryGetValue("version", out value) ? SemanticVersion.Parse(value as string) : null;
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (ArgumentException) { }
        catch (InvalidOperationException) { }
        return null;
    }
    internal static string FindNode(CancellationToken cancellation)
    {
        var candidates = new List<string>
        {
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "node", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "dsh-desktop", "node", "node.exe")
        };
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            try { if (!string.IsNullOrWhiteSpace(directory)) candidates.Add(Path.Combine(directory.Trim().Trim('"'), "node.exe")); }
            catch (ArgumentException) { }
        }
        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"));
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string path in candidates)
        {
            cancellation.ThrowIfCancellationRequested();
            if (!seen.Add(path) || !File.Exists(path)) continue;
            string output;
            if (!CheckRuntime(path, "--version", cancellation, out output)) continue;
            var version = SemanticVersion.Parse(output);
            if (version == null || !version.SupportedNode) continue;
            if (CheckRuntime(path, "--input-type=module -e \"process.exit(import.meta.main === true ? 0 : 7)\"", cancellation, out output)) return path;
        }
        return null;
    }
    private static bool CheckRuntime(string path, string arguments, CancellationToken cancellation, out string output)
    {
        output = "";
        try
        {
            using (var process = new Process { StartInfo = new ProcessStartInfo(path, arguments)
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true } })
            {
                process.Start();
                var stdout = process.StandardOutput.ReadToEndAsync();
                var stderr = process.StandardError.ReadToEndAsync();
                var watch = Stopwatch.StartNew();
                while (!process.WaitForExit(50))
                {
                    if (cancellation.IsCancellationRequested || watch.ElapsedMilliseconds > 3000)
                    { try { process.Kill(); } catch (InvalidOperationException) { } cancellation.ThrowIfCancellationRequested(); return false; }
                }
                if (!stdout.Wait(500) || !stderr.Wait(500)) return false;
                output = stdout.Result.Trim();
                return process.ExitCode == 0 && output.Length <= 1024;
            }
        }
        catch (System.ComponentModel.Win32Exception) { }
        catch (IOException) { }
        catch (InvalidOperationException) { }
        return false;
    }
}
