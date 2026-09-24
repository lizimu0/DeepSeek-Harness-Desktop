using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal static class LauncherTests
{
    private static int _assertions;
    private static void Check(bool ok, string message)
    {
        _assertions++;
        if (!ok) throw new InvalidOperationException(message);
    }
    private static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--idle-child") { Thread.Sleep(Timeout.Infinite); return 0; }
        if (args.Length > 0 && args[0] == "--exit-child") return 23;
        try
        {
            if (args.Length > 0 && args[0] == "--probe-existing") return ProbeExisting(args).GetAwaiter().GetResult();
            Run().GetAwaiter().GetResult();
            Console.WriteLine("PASS launcher: " + _assertions + " assertions (isolated loopback only)");
            return 0;
        }
        catch (Exception error)
        {
            // Test diagnostics never dump request URLs, cookie jars or exception payloads.
            Console.Error.WriteLine("FAIL launcher: " + error.GetType().Name + " " + LauncherPolicy.Redact(error.Message));
            return 1;
        }
    }

    private static async Task<int> ProbeExisting(string[] args)
    {
        int port = args.Length > 1 ? int.Parse(args[1]) : 3080;
        var options = new LauncherOptions { Port = port, AllowStart = false, PersistState = false, ReadyTimeout = TimeSpan.FromSeconds(40) };
        if (args.Length > 2) options.LogDirectory = Path.GetFullPath(args[2]);
        if (args.Length > 3) options.StateDirectory = Path.GetFullPath(args[3]);
        var service = new LauncherService(options, token => { throw new InvalidOperationException("read-only probe attempted start"); }, null);
        try
        {
            var result = await service.EnsureReadyAsync();
            Console.WriteLine("Existing local service: online=" + result.Online + " ready=" + result.Ready + " rootHttp=" + result.HttpStatus);
            Console.WriteLine("Only local root GET/token exchange; no process start/stop, no provider request, no token output.");
            return result.Ready ? 0 : 2;
        }
        finally { service.ShutdownAsync().GetAwaiter().GetResult(); }
    }

    private static async Task Run()
    {
        string temp = Path.Combine(Path.GetTempPath(), "dsh-launcher-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        try
        {
            UrlsAndRedaction();
            FilesAndVersions(temp);
            await ReadinessAndAuth(temp);
            await ConcurrencyAndLifetime(temp);
        }
        finally { try { Directory.Delete(temp, true); } catch (IOException) { } }
    }

    private static void UrlsAndRedaction()
    {
        Uri uri;
        string origin = LauncherPolicy.Origin(3080);
        Check(LauncherPolicy.TryTokenUrl(origin + "/?token=abc_X-9", 3080, out uri), "valid local token");
        string[] invalid = {
            "http://127.0.0.1.evil:3080/?token=x", "http://127.0.0.1:30800/?token=x", "http://127.0.0.1:3081/?token=x",
            "https://127.0.0.1:3080/?token=x", "http://localhost:3080/?token=x", "http://2130706433:3080/?token=x",
            "http://127.1:3080/?token=x", "http://127.0.0.1:03080/?token=x", "http://127.0.0.1:3080@evil/?token=x",
            "http://user@127.0.0.1:3080/?token=x", "http://127.0.0.1:3080\\@evil/?token=x", origin + "/api?token=x",
            origin + "/?token=", origin + "/?TOKEN=x", origin + "/?token=x&token=y", origin + "/?token=x#x",
            origin + "/?token=x&next=https://evil", origin + "/?token=%78", origin + "/?token=x\n", origin + "/a/../?token=x"
        };
        foreach (string value in invalid) Check(!LauncherPolicy.TryTokenUrl(value, 3080, out uri), "reject token URL ambiguity");
        Check(!LauncherPolicy.TryLocalUri("http://127.0.0.1:30800/", 3080, out uri), "port prefix disallowed");
        Check(LauncherPolicy.TryLocalUri(origin + "/sessions/123", 3080, out uri), "local navigation path allowed");
        Check(!LauncherPolicy.TryExternalUri("javascript:alert(1)", true, false, 3080, out uri), "javascript blocked");
        Check(!LauncherPolicy.TryExternalUri("file:///C:/Windows/system32/cmd.exe", true, false, 3080, out uri), "file blocked");
        Check(!LauncherPolicy.TryExternalUri("ms-settings:privacy", true, false, 3080, out uri), "custom scheme blocked");
        Check(!LauncherPolicy.TryExternalUri("https://example.com/", false, false, 3080, out uri), "automatic popup blocked");
        Check(!LauncherPolicy.TryExternalUri("https://example.com/", true, true, 3080, out uri), "automatic redirect blocked");
        Check(LauncherPolicy.TryExternalUri("https://example.com/", true, false, 3080, out uri), "user HTTPS allowed");
        Check(LauncherPolicy.TryExternalUri("http://example.com/", true, false, 3080, out uri), "user HTTP allowed");
        Check(!LauncherPolicy.TryRootRedirect(new Uri(origin), new Uri("http://example.com/"), 3080, out uri), "cross origin redirect blocked");
        Check(!LauncherPolicy.TryRootRedirect(new Uri(origin), new Uri("/api/refresh", UriKind.Relative), 3080, out uri), "non-root redirect blocked");
        Check(LauncherPolicy.TryRootRedirect(new Uri(origin), new Uri("/", UriKind.Relative), 3080, out uri), "clean root redirect allowed");
        string secret = "testSecret_0123456789";
        foreach (string value in new[] { origin + "/?token=" + secret, "token='" + secret + "'", "{\"apiKey\":\"" + secret + "\"}",
            "api_key=" + secret, "key: " + secret, "Authorization: Bearer " + secret, "Cookie: dsh-auth=" + secret })
            Check(!LauncherPolicy.Redact(value).Contains(secret), "sensitive material redacted");
        Check(LauncherPolicy.Redact("reason exitCode=23 中文").Contains("exitCode=23"), "exit diagnostics retained");
        Check(!LauncherPolicy.IsHtmlReady(404, "text/html", "<!doctype html>"), "404 not ready");
        Check(!LauncherPolicy.IsHtmlReady(401, "text/html", "<!doctype html>"), "401 not ready");
        Check(!LauncherPolicy.IsHtmlReady(500, "text/html", "<!doctype html>"), "500 not ready");
        Check(!LauncherPolicy.IsHtmlReady(200, "application/json", "{}"), "JSON not UI-ready");
        Check(LauncherPolicy.IsHtmlReady(200, "text/html", "<!doctype html><html>"), "HTML 200 ready");
        Check(!LauncherPolicy.CanStart(false, true, false, true, 0, 2), "alive child blocks duplicate");
        Check(!LauncherPolicy.CanStart(false, false, true, true, 0, 2), "online 401/404 blocks duplicate");
        Check(!LauncherPolicy.CanStart(true, false, false, true, 0, 2), "shutdown blocks start");
        Check(!LauncherPolicy.CanStart(false, false, false, false, 0, 2), "unknown port blocks start");
        Check(!LauncherPolicy.CanStart(false, false, false, true, 2, 2), "start retries bounded");
        var retries = new RetryBudget(5);
        for (int i = 1; i <= 5; i++)
        {
            int delay;
            Check(retries.TrySchedule(out delay) && delay == 800 * i, "backoff increments");
            Check(!retries.TrySchedule(out delay), "duplicate event dedup");
            retries.CompleteAttempt();
        }
        int ignored;
        Check(!retries.TrySchedule(out ignored), "navigation retry cap");
        retries.Reset();
        Check(retries.TrySchedule(out ignored), "manual open resets bounded retry");
    }

    private static void FilesAndVersions(string temp)
    {
        string tail = Path.Combine(temp, "legacy.log");
        File.WriteAllText(tail, "http://127.0.0.1:3080/?token=old\n" + new string('a', 200000) + "\n"
            + "http://127.0.0.1:9999/?token=wrong\nhttp://127.0.0.1:3080/?token=current\n", Encoding.UTF8);
        string text = LauncherPolicy.ReadTail(tail, 512);
        Check(Encoding.UTF8.GetByteCount(text) <= 512 && !text.Contains("token=old"), "bounded tail excludes history");
        var candidates = LauncherPolicy.ExtractTokenUrls(text, 3080, 8);
        Check(candidates.Count == 1 && candidates[0].EndsWith("=current"), "tail validates exact port");
        string log = Path.Combine(temp, "rotating.log");
        var logger = new LauncherLog(log, 20);
        logger.Write("private token=SecretValue 中文");
        logger.Write("exitCode=23 reason=unexpected");
        Check(Directory.GetFiles(temp, "rotating.log.*.old").Length == 1, "rotation preserves archive");
        foreach (string path in Directory.GetFiles(temp, "rotating.log*")) Check(!File.ReadAllText(path).Contains("SecretValue"), "both logs sanitized");
        Check(SemanticVersion.Parse("0.1.5-rc.10").CompareTo(SemanticVersion.Parse("0.1.5-rc.2")) > 0, "numeric prerelease order");
        Check(SemanticVersion.Parse("0.1.5").CompareTo(SemanticVersion.Parse("0.1.5-rc.99")) > 0, "stable beats prerelease");
        Check(SemanticVersion.Parse("1.0.0+build.1").CompareTo(SemanticVersion.Parse("1.0.0+build.2")) == 0, "build metadata ignored");
        Check(SemanticVersion.Parse("1.0.0-rc.02") == null && SemanticVersion.Parse("01.0.0") == null, "invalid semver rejected");
        Check(!SemanticVersion.Parse("v22.14.0").SupportedNode && SemanticVersion.Parse("v22.18.0").SupportedNode
            && SemanticVersion.Parse("v24.2.0").SupportedNode, "Node version floor; actual main capability is separately probed");
        string package = Path.Combine(temp, "package.json");
        File.WriteAllText(package, "{\"name\":\"fixture\",\"version\":\"0.1.5-rc.10\"}");
        Check(LauncherRuntime.ReadPackageVersion(package).CompareTo(SemanticVersion.Parse("0.1.5-rc.10")) == 0, "compact package JSON");
        var alerts = LauncherPolicy.ParseAlerts("{\"alerts\":[{\"key\":\"a\",\"message\":\"balance low\"},{\"key\":3,\"message\":\"invalid\"}]}" );
        Check(alerts.Count == 1, "JSON array alerts parsed without ArrayList assumption");
        foreach (string bad in new[] { "{\"ok\":false,\"alerts\":[]}", "{\"error\":\"not-ready\",\"alerts\":[]}" })
        {
            bool rejected = false;
            try { LauncherPolicy.ParseAlerts(bad); } catch (FormatException) { rejected = true; }
            Check(rejected, "failed alerts envelope cannot count as success");
        }
        DateTime day = new DateTime(2026, 9, 20, 12, 0, 0);
        string ledgerPath = Path.Combine(temp, "seen.txt");
        var ledger = new AlertLedger(ledgerPath, day);
        Check(ledger.MarkSeen("a", day) && !ledger.MarkSeen("a", day), "daily alert dedup");
        ledger.Save();
        Check(!new AlertLedger(ledgerPath, day).MarkSeen("a", day), "daily dedup survives restart");
        Check(ledger.MarkSeen("a", day.AddDays(1)), "daily alert reset");
        var store = new TokenStore(Path.Combine(temp, "auth.dat"));
        var live = new PortSnapshot { Known = true, Listening = true, Pid = 12, StartTicks = 345 };
        string tokenUrl = "http://127.0.0.1:3080/?token=PrivateSyntheticToken";
        store.Save(3080, live, tokenUrl);
        Check(!File.ReadAllText(Path.Combine(temp, "auth.dat")).Contains("PrivateSyntheticToken"), "DPAPI private state encrypted");
        Check(store.Read(3080, live) == tokenUrl, "live process state recovered");
        Check(store.Read(3080, new PortSnapshot { Known = true, Listening = true, Pid = 12, StartTicks = 346 }) == null, "PID reuse rejected");
        Check(store.Read(3081, live) == null, "state port mismatch rejected");
    }

    private static LauncherOptions Options(string temp, int port)
    {
        return new LauncherOptions
        {
            Port = port, ReadyTimeout = TimeSpan.FromMilliseconds(900), RequestTimeout = TimeSpan.FromMilliseconds(350),
            PollInterval = TimeSpan.FromMilliseconds(20), PersistState = false,
            LogDirectory = Path.Combine(temp, Guid.NewGuid().ToString("N")), StateDirectory = Path.Combine(temp, "state")
        };
    }
    private static async Task ReadinessAndAuth(string temp)
    {
        using (var server = new FakeServer())
        {
            var options = Options(temp, server.Port);
            using (var session = new LocalSession(server.Port, TimeSpan.FromSeconds(2)))
            {
                server.Mode = 404;
                var result = await session.ProbeAsync(null, CancellationToken.None);
                Check(result.Online && !result.Ready && result.Status == 404, "HTTP404 online but not ready");
                server.Mode = 500;
                result = await session.ProbeAsync(null, CancellationToken.None);
                Check(result.Online && !result.Ready && result.Status == 500, "HTTP500 online but not ready");
                server.Mode = 200;
                result = await session.ProbeAsync(null, CancellationToken.None);
                Check(result.Ready, "legacy unauthenticated 200 HTML");
            }
            server.Mode = 401;
            using (var session = new LocalSession(server.Port, TimeSpan.FromSeconds(2)))
            {
                Check(!(await session.ProbeAsync(null, CancellationToken.None)).Ready, "anonymous denied");
                Check(!(await session.ProbeAsync(server.Root + "?token=stale", CancellationToken.None)).Ready, "stale token denied");
                Check((await session.ProbeAsync(server.TokenUrl, CancellationToken.None)).Ready, "token 303 then clean-root cookie200");
                var alerts = await session.GetAlertsAsync(CancellationToken.None);
                Check(alerts.Status == 200 && alerts.Alerts.Count == 1, "authenticated alerts reuse cookie session");
            }
            int starts = 0;
            Directory.CreateDirectory(options.LogDirectory);
            File.WriteAllText(Path.Combine(options.LogDirectory, "web-server.log"), server.TokenUrl + "\n" + server.Root + "?token=stale\n");
            var service = new LauncherService(options, cancellation => { starts++; throw new InvalidOperationException("unexpected start"); }, null);
            try
            {
                var result = await service.EnsureReadyAsync();
                Check(result.Ready && starts == 0, "fallback rejects newest stale token and validates earlier current candidate");
                Check((await service.GetAlertsAsync(CancellationToken.None)).Status == 200, "service alerts authenticated");
                Check(service.BrowserCookies().Cookies.Length == 1, "browser receives verified cookie not token URL");
            }
            finally { service.ShutdownAsync().GetAwaiter().GetResult(); }
            options = Options(temp, server.Port);
            var denied = new LauncherService(options, cancellation => { starts++; return null; }, null);
            try { Check(!(await denied.EnsureReadyAsync()).Ready && starts == 0, "existing401 never starts second server"); }
            finally { denied.ShutdownAsync().GetAwaiter().GetResult(); }
            server.Mode = 404;
            var mounting = new LauncherService(Options(temp, server.Port), cancellation => { starts++; return null; }, null);
            try
            {
                Task<ReadyResult> wait = mounting.EnsureReadyAsync();
                await Task.Delay(75);
                server.Mode = 200;
                Check((await wait).Ready && starts == 0, "404 mounting waits until200 without spawn");
            }
            finally { mounting.ShutdownAsync().GetAwaiter().GetResult(); }
            server.Mode = 302;
            using (var session = new LocalSession(server.Port, TimeSpan.FromSeconds(2)))
                Check((await session.ProbeAsync(null, CancellationToken.None)).Detail == "blocked_redirect", "HTTP cross origin redirect not followed");
            server.Mode = 307;
            using (var session = new LocalSession(server.Port, TimeSpan.FromSeconds(2)))
                Check((await session.ProbeAsync(null, CancellationToken.None)).Detail == "redirect_limit", "redirects bounded");
            server.Mode = 200;
            server.DelayMs = 2000;
            using (var cancel = new CancellationTokenSource())
            using (var session = new LocalSession(server.Port, TimeSpan.FromSeconds(3)))
            {
                var watch = Stopwatch.StartNew();
                Task<HttpObservation> wait = session.ProbeAsync(null, cancel.Token);
                cancel.CancelAfter(40);
                bool canceled = false;
                try { await wait; } catch (OperationCanceledException) { canceled = true; }
                Check(canceled && watch.ElapsedMilliseconds < 1500, "in-flight HTTP cancellation");
            }
            Check(server.ForeignRequests == 0, "root probe made no business POST/API request");
        }
    }

    private static async Task ConcurrencyAndLifetime(string temp)
    {
        int calls = 0;
        var release = new TaskCompletionSource<int>();
        var flight = new AsyncSingleFlight<int>();
        var tasks = new List<Task<int>>();
        for (int i = 0; i < 30; i++) tasks.Add(flight.Run(async () => { Interlocked.Increment(ref calls); return await release.Task; }));
        release.SetResult(42);
        await Task.WhenAll(tasks);
        Check(calls == 1, "30 callers share one readiness flight");
        foreach (var task in tasks) Check(object.ReferenceEquals(task, tasks[0]), "flight task dedup");
        int port;
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start(); port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
        int starts = 0;
        ProcessStartInfo child = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--idle-child");
        var options = Options(temp, port);
        options.ReadyTimeout = TimeSpan.FromMilliseconds(900);
        options.RequestTimeout = TimeSpan.FromMilliseconds(100);
        var service = new LauncherService(options, cancellation => { starts++; return child; }, null);
        try
        {
            var result = await service.EnsureReadyAsync();
            Check(!result.Ready && starts == 1, "slow alive owned child starts once");
            result = await service.EnsureReadyAsync();
            Check(!result.Ready && starts == 1, "timeout and reopen do not duplicate alive child");
        }
        finally { service.ShutdownAsync().GetAwaiter().GetResult(); }
        Check(!(await service.EnsureReadyAsync()).Ready && starts == 1, "post-dispose request cannot restart");
        starts = 0;
        options = Options(temp, port);
        options.ReadyTimeout = TimeSpan.FromSeconds(3);
        var crashing = new LauncherService(options, cancellation =>
        { starts++; return new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--exit-child"); }, null);
        try
        {
            var result = await crashing.EnsureReadyAsync();
            Check(!result.Ready && starts == 2, "exit retry limited to two starts");
        }
        finally { crashing.ShutdownAsync().GetAwaiter().GetResult(); }
        Check(File.ReadAllText(crashing.LogPath).Contains("exitCode=23"), "real child exit code logged");
        using (var server = new FakeServer())
        {
            server.Mode = 200;
            var existing = new LauncherService(Options(temp, server.Port), cancellation => null, null);
            Check((await existing.EnsureReadyAsync()).Ready, "existing listener adopted");
            await existing.ShutdownAsync();
            using (var session = new LocalSession(server.Port, TimeSpan.FromSeconds(1)))
                Check((await session.ProbeAsync(null, CancellationToken.None)).Ready, "shutdown leaves unowned existing service running");
        }
    }
}

// Real sockets, no HttpListener URL ACL/admin dependency, never binds the production port.
internal sealed class FakeServer : IDisposable
{
    private readonly TcpListener _listener;
    private readonly CancellationTokenSource _stop = new CancellationTokenSource();
    private readonly Task _loop;
    internal volatile int Mode = 401;
    internal volatile int DelayMs;
    internal int ForeignRequests;
    internal readonly int Port;
    internal string Root { get { return LauncherPolicy.Origin(Port) + "/"; } }
    internal string TokenUrl { get { return Root + "?token=fixtureToken"; } }
    internal FakeServer()
    {
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _loop = Task.Run(new Func<Task>(Accept));
    }
    private async Task Accept()
    {
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                var client = await _listener.AcceptTcpClientAsync();
                Handle(client);
            }
            catch (ObjectDisposedException) { break; }
            catch (SocketException) { break; }
        }
    }
    private async void Handle(TcpClient client)
    {
        using (client)
        {
            try
            {
                using (var stream = client.GetStream())
                using (var reader = new StreamReader(stream, Encoding.ASCII, false, 4096, true))
                {
                    string first = await reader.ReadLineAsync();
                    if (first == null) return;
                    string[] parts = first.Split(' ');
                    string path = parts[1];
                    bool cookie = false;
                    string line;
                    while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync()))
                        if (line.StartsWith("Cookie:", StringComparison.OrdinalIgnoreCase) && line.Contains("fixture=good")) cookie = true;
                    if (DelayMs > 0) await Task.Delay(DelayMs, _stop.Token);
                    int status = Mode;
                    string extra = "", body = "not ready", content = "text/plain";
                    if (parts[0] != "GET" || (path != "/" && !path.StartsWith("/?token=") && path != "/balance-card/alerts"))
                    { Interlocked.Increment(ref ForeignRequests); status = 400; }
                    else if (path == "/balance-card/alerts")
                    { status = cookie ? 200 : 401; body = "{\"alerts\":[{\"key\":\"balance:day\",\"message\":\"fixture low balance\"}]}"; content = "application/json"; }
                    else if (Mode == 401)
                    {
                        if (path == "/?token=fixtureToken") { status = 303; extra = "Location: /\r\nSet-Cookie: fixture=good; Path=/; HttpOnly\r\n"; }
                        else if (path == "/" && cookie) status = 200;
                    }
                    else if (Mode == 302) extra = "Location: https://example.invalid/\r\n";
                    else if (Mode == 307) extra = "Location: /\r\n";
                    if (status == 200 && path != "/balance-card/alerts") { content = "text/html"; body = "<!doctype html><html><body>fixture</body></html>"; }
                    byte[] bytes = Encoding.UTF8.GetBytes(body);
                    string headers = "HTTP/1.1 " + status + " Fixture\r\nConnection: close\r\nContent-Type: " + content + "; charset=utf-8\r\nContent-Length: " + bytes.Length + "\r\n" + extra + "\r\n";
                    byte[] header = Encoding.ASCII.GetBytes(headers);
                    await stream.WriteAsync(header, 0, header.Length);
                    await stream.WriteAsync(bytes, 0, bytes.Length);
                }
            }
            catch (IOException) { }
            catch (OperationCanceledException) { }
            catch (ObjectDisposedException) { }
            catch (SocketException) { }
        }
    }
    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
        _loop.GetAwaiter().GetResult();
        // Handlers use cancellation tokens, not the source after this point.
    }
}
