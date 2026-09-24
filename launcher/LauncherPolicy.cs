using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// No WinForms/WebView2 dependencies: this file is compiled by the standalone tests too.
internal static class LauncherPolicy
{
    internal const int MaxLogTailBytes = 128 * 1024;
    internal const int MaxCandidates = 8;
    private static readonly Regex UrlInText = new Regex(@"https?://[^\s<>""'\x1b]+", RegexOptions.IgnoreCase);
    private static readonly Regex Ansi = new Regex(@"\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))");
    private const string SecretName = @"(?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|key|secret|password|authorization|cookie|set-cookie)";
    private static readonly Regex QuotedSecret = new Regex(@"(?i)([""']?" + SecretName + @"[""']?\s*[:=]\s*)([""'])(.*?)\2");
    private static readonly Regex PlainSecret = new Regex(@"(?i)(\b" + SecretName + @"\b\s*[:=]\s*)(?![""'])([^\s&,;<>""']+)");
    private static readonly Regex AuthHeader = new Regex(@"(?i)(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+");
    private static readonly Regex Bearer = new Regex(@"(?i)\b(Bearer\s+)[A-Za-z0-9._~+/=-]+");
    private static readonly Regex ProviderKey = new Regex(@"\bsk-[A-Za-z0-9_-]{8,}");

    internal static string Origin(int port)
    {
        if (port < 1 || port > 65535) throw new ArgumentOutOfRangeException("port");
        return "http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture);
    }

    internal static bool TryLocalUri(string value, int port, out Uri uri)
    {
        uri = null;
        if (string.IsNullOrEmpty(value) || HasUnsafeCharacters(value)) return false;
        string origin = Origin(port);
        if (!value.StartsWith(origin, StringComparison.OrdinalIgnoreCase)) return false;
        if (value.Length > origin.Length && "/?#".IndexOf(value[origin.Length]) < 0) return false;
        Uri parsed;
        if (!Uri.TryCreate(value, UriKind.Absolute, out parsed) || parsed.Scheme != "http"
            || parsed.Host != "127.0.0.1" || parsed.Port != port || parsed.UserInfo.Length != 0) return false;
        uri = parsed;
        return true;
    }

    internal static bool TryTokenUrl(string value, int port, out Uri uri)
    {
        uri = null;
        Uri parsed;
        if (!TryLocalUri(value, port, out parsed)) return false;
        string prefix = Origin(port) + "/?token=";
        if (!value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;
        // Exactly one, case-sensitive token parameter; no fragments, aliases, escapes or extra query keys.
        if (!string.Equals(value.Substring(Origin(port).Length, 8), "/?token=", StringComparison.Ordinal)) return false;
        string token = value.Substring(prefix.Length);
        if (token.Length == 0 || token.Length > 512) return false;
        foreach (char c in token)
            if (!(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') && !(c >= '0' && c <= '9') && c != '_' && c != '-') return false;
        uri = parsed;
        return true;
    }

    internal static bool IsCleanRoot(Uri uri, int port)
    {
        Uri parsed;
        return uri != null && TryLocalUri(uri.OriginalString, port, out parsed)
            && parsed.AbsolutePath == "/" && parsed.Query.Length == 0 && parsed.Fragment.Length == 0;
    }

    internal static bool TryRootRedirect(Uri current, Uri location, int port, out Uri target)
    {
        target = null;
        if (current == null || location == null) return false;
        try
        {
            Uri next = location.IsAbsoluteUri ? location : new Uri(current, location);
            if (!IsCleanRoot(next, port)) return false;
            target = next;
            return true;
        }
        catch (UriFormatException) { return false; }
    }

    internal static bool TryExternalUri(string value, bool userInitiated, bool redirected, int port, out Uri uri)
    {
        uri = null;
        if (!userInitiated || redirected || string.IsNullOrEmpty(value) || HasUnsafeCharacters(value)) return false;
        Uri parsed, local;
        if (!Uri.TryCreate(value, UriKind.Absolute, out parsed) || parsed.UserInfo.Length != 0
            || (parsed.Scheme != "http" && parsed.Scheme != "https") || string.IsNullOrEmpty(parsed.Host)
            || TryLocalUri(value, port, out local)) return false;
        uri = parsed;
        return true;
    }

    private static bool HasUnsafeCharacters(string value)
    {
        foreach (char c in value) if (char.IsWhiteSpace(c) || char.IsControl(c) || c == '\\') return true;
        return false;
    }

    internal static List<string> ExtractTokenUrls(string text, int port, int limit)
    {
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var matches = UrlInText.Matches(Ansi.Replace(text ?? "", ""));
        for (int i = matches.Count - 1; i >= 0 && result.Count < limit; i--)
        {
            string candidate = matches[i].Value.TrimEnd(')', ']', '}', ',', '.', ';');
            Uri uri;
            if (TryTokenUrl(candidate, port, out uri) && seen.Add(candidate)) result.Add(candidate);
        }
        return result;
    }

    internal static string ReadTail(string path, int maxBytes)
    {
        if (maxBytes < 1 || maxBytes > MaxLogTailBytes) throw new ArgumentOutOfRangeException("maxBytes");
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            long start = Math.Max(0, stream.Length - maxBytes);
            stream.Seek(start, SeekOrigin.Begin);
            byte[] buffer = new byte[maxBytes];
            int read = 0, count;
            while (read < buffer.Length && (count = stream.Read(buffer, read, buffer.Length - read)) > 0) read += count;
            string text = Encoding.UTF8.GetString(buffer, 0, read);
            // A partial first line may contain the tail of an unrelated URL; never interpret it.
            if (start > 0)
            {
                int newline = text.IndexOf('\n');
                text = newline < 0 ? "" : text.Substring(newline + 1);
            }
            return text;
        }
    }

    internal static string Redact(string message)
    {
        string text = Ansi.Replace(message ?? "", "");
        text = AuthHeader.Replace(text, "$1[REDACTED]");
        text = QuotedSecret.Replace(text, "$1$2[REDACTED]$2");
        text = PlainSecret.Replace(text, "$1[REDACTED]");
        text = Bearer.Replace(text, "$1[REDACTED]");
        text = ProviderKey.Replace(text, "[REDACTED]");
        return text;
    }

    internal static bool IsHtmlReady(int statusCode, string mediaType, string prefix)
    {
        if (statusCode != 200 || (mediaType != "text/html" && mediaType != "application/xhtml+xml")) return false;
        string text = prefix ?? "";
        return text.IndexOf("<!doctype html", StringComparison.OrdinalIgnoreCase) >= 0
            || text.IndexOf("<html", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    internal static bool CanStart(bool stopping, bool ownedAlive, bool online, bool listenerKnown, int attempts, int maximum)
    {
        return !stopping && !ownedAlive && !online && listenerKnown && attempts < maximum;
    }

    internal static List<LauncherAlert> ParseAlerts(string json)
    {
        var serializer = new JavaScriptSerializer { MaxJsonLength = 128 * 1024, RecursionLimit = 32 };
        var root = serializer.Deserialize<Dictionary<string, object>>(json);
        object raw, error, ok;
        if (root == null || (root.TryGetValue("error", out error) && error != null)
            || (root.TryGetValue("ok", out ok) && ok is bool && !(bool)ok)
            || !root.TryGetValue("alerts", out raw) || raw is string || raw is IDictionary)
            throw new FormatException("Invalid alerts envelope");
        var items = raw as IEnumerable;
        if (items == null) throw new FormatException("Invalid alerts array");
        var result = new List<LauncherAlert>();
        foreach (object item in items)
        {
            var entry = item as IDictionary<string, object>;
            object key, message;
            if (entry == null || !entry.TryGetValue("key", out key) || !entry.TryGetValue("message", out message)) continue;
            string k = key as string, m = message as string;
            if (string.IsNullOrWhiteSpace(k) || k.Length > 256 || k.IndexOfAny(new[] { '\r', '\n' }) >= 0
                || string.IsNullOrWhiteSpace(m)) continue;
            result.Add(new LauncherAlert(k, m.Length > 2048 ? m.Substring(0, 2048) : m));
            if (result.Count == 100) break;
        }
        return result;
    }
}

internal sealed class LauncherAlert
{
    internal readonly string Key;
    internal readonly string Message;
    internal LauncherAlert(string key, string message) { Key = key; Message = message; }
}

internal sealed class AsyncSingleFlight<T>
{
    private readonly object _sync = new object();
    private Task<T> _flight;
    internal Task<T> Run(Func<Task<T>> operation)
    {
        lock (_sync)
        {
            if (_flight == null || _flight.IsCompleted) _flight = Task.Run(operation);
            return _flight;
        }
    }
    internal Task<T> Current { get { lock (_sync) return _flight; } }
}

// A failed navigation consumes one slot, not one per WebView callback. A 401 "success"
// must never reset this budget; reset only after an HTTP 200 document actually paints.
internal sealed class RetryBudget
{
    private readonly int _maximum;
    internal int Attempts { get; private set; }
    internal bool Pending { get; private set; }
    internal RetryBudget(int maximum) { _maximum = maximum; }
    internal bool TrySchedule(out int delayMs)
    {
        delayMs = 0;
        if (Pending || Attempts >= _maximum) return false;
        Pending = true;
        delayMs = 800 * ++Attempts;
        return true;
    }
    internal void CompleteAttempt() { Pending = false; }
    internal void Reset() { Attempts = 0; Pending = false; }
}

internal sealed class AlertLedger
{
    private readonly string _path;
    private string _day;
    private readonly HashSet<string> _keys = new HashSet<string>(StringComparer.Ordinal);
    internal AlertLedger(string path, DateTime now)
    {
        _path = path;
        _day = Day(now);
        try
        {
            if (new FileInfo(path).Length > 512 * 1024) return;
            string[] lines = File.ReadAllLines(path, Encoding.UTF8);
            if (lines.Length == 0 || lines[0] != "v1:" + _day) return;
            for (int i = 1; i < lines.Length && _keys.Count < 2048; i++)
                if (lines[i].Length > 0 && lines[i].Length <= 256) _keys.Add(lines[i]);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
    private static string Day(DateTime now) { return now.ToString("yyyyMMdd", CultureInfo.InvariantCulture); }
    internal bool MarkSeen(string key, DateTime now)
    {
        string day = Day(now);
        if (day != _day) { _day = day; _keys.Clear(); }
        if (string.IsNullOrEmpty(key) || key.Length > 256 || key.IndexOfAny(new[] { '\r', '\n' }) >= 0 || _keys.Count >= 2048) return false;
        return _keys.Add(key);
    }
    internal void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path));
            var lines = new List<string> { "v1:" + _day };
            lines.AddRange(_keys);
            LauncherFiles.AtomicWrite(_path, string.Join(Environment.NewLine, lines.ToArray()));
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

internal static class LauncherFiles
{
    internal static void AtomicWrite(string path, string value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temp, value, new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(temp, path, null);
            else File.Move(temp, path);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}

internal sealed class LauncherLog
{
    private readonly object _sync = new object();
    private readonly string _path;
    private readonly long _maxBytes;
    internal LauncherLog(string path, long maxBytes) { _path = path; _maxBytes = maxBytes; }
    internal void Write(string message)
    {
        try
        {
            string safe = LauncherPolicy.Redact(message).Replace("\r", "\\r").Replace("\n", "\\n");
            if (safe.Length > 64 * 1024) safe = safe.Substring(0, 64 * 1024) + " [truncated]";
            lock (_sync)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path));
                if (File.Exists(_path) && new FileInfo(_path).Length >= _maxBytes)
                {
                    // Keep pre-existing logs intact, including old unredacted historical logs.
                    string archive = _path + "." + DateTime.UtcNow.ToString("yyyyMMddTHHmmssfff", CultureInfo.InvariantCulture)
                        + "." + Guid.NewGuid().ToString("N").Substring(0, 8) + ".old";
                    try { File.Move(_path, archive); } catch (IOException) { }
                }
                using (var stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                // Explicit UTF-8 without BOM, consistently for both launcher and child output.
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
                    writer.WriteLine("[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "] " + safe);
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

internal sealed class SemanticVersion : IComparable<SemanticVersion>
{
    private static readonly Regex Pattern = new Regex(@"\A(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\z");
    private readonly string[] _core;
    private readonly string[] _pre;
    private SemanticVersion(string[] core, string[] pre) { _core = core; _pre = pre; }
    internal static SemanticVersion Parse(string text)
    {
        var match = Pattern.Match((text ?? "").Trim());
        if (!match.Success) return null;
        string[] pre = match.Groups[4].Success ? match.Groups[4].Value.Split('.') : new string[0];
        foreach (string part in pre) if (IsNumeric(part) && part.Length > 1 && part[0] == '0') return null;
        return new SemanticVersion(new[] { match.Groups[1].Value, match.Groups[2].Value, match.Groups[3].Value }, pre);
    }
    private static bool IsNumeric(string value)
    {
        foreach (char c in value) if (c < '0' || c > '9') return false;
        return value.Length != 0;
    }
    private static int CompareNumber(string left, string right)
    {
        return left.Length != right.Length ? left.Length.CompareTo(right.Length) : string.CompareOrdinal(left, right);
    }
    public int CompareTo(SemanticVersion other)
    {
        if (other == null) return 1;
        for (int i = 0; i < 3; i++) { int n = CompareNumber(_core[i], other._core[i]); if (n != 0) return n; }
        if (_pre.Length == 0 || other._pre.Length == 0)
            return _pre.Length == other._pre.Length ? 0 : (_pre.Length == 0 ? 1 : -1);
        for (int i = 0; i < Math.Min(_pre.Length, other._pre.Length); i++)
        {
            bool a = IsNumeric(_pre[i]), b = IsNumeric(other._pre[i]);
            int n = a && b ? CompareNumber(_pre[i], other._pre[i]) : a != b ? (a ? -1 : 1) : string.CompareOrdinal(_pre[i], other._pre[i]);
            if (n != 0) return n;
        }
        return _pre.Length.CompareTo(other._pre.Length);
    }
    internal bool SupportedNode
    {
        // Version is only a coarse floor; FindNode also probes import.meta.main.
        // Newer 22.x releases may have the feature even though older 24.0 releases do not.
        get { return _pre.Length == 0 && CompareTo(Parse("22.15.0")) >= 0; }
    }
}
