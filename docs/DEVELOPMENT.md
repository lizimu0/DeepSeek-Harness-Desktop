# Development and verification

## Supported environment

- Windows 10/11, WebView2 Runtime, .NET Framework 4.8.
- PowerShell 5.1 or PowerShell 7 for Windows scripts.
- Node.js 24.2 or later for the test suite (validated on 24.21). Use the optional portable runtime without replacing the system Node.
- DSH 0.1.5-rc.2 is the locally verified integration target. An `rc` version remains a prerelease even when npm assigns it the `latest` tag.

## Tests

```powershell
npm install --ignore-scripts
npm run verify
npm run test:windows
```

If your global Node is older, prepend the portable runtime **only for this shell** before running npm:

```powershell
$env:PATH = "$env:USERPROFILE\dsh-desktop\node;" + $env:PATH
```

The JavaScript tests use `node:test`, temporary session fixtures and jsdom. They do not send requests to model providers, read production credentials, change the selected model, or stop production processes.

The Windows suite compiles and tests launcher policies and validates installation/build scripts using temporary paths. It does not register login startup entries. UI checks use an isolated local preview with fixture data; API authentication checks should use a local test server, never fabricate a credential or disable DSH's authentication fence.

## Ownership and changes

- Work on a branch, preserve uncommitted user changes, and review `git diff` before staging. Commit/push only with explicit user authorization.
- Never use process-name-wide termination (`taskkill /IM node.exe`) for DSH. A port number or a process named `node` alone does not establish ownership.
- Validate readiness separately from liveness. A listening HTTP service returning 404/500 is not a loaded DSH application.
- Authentication tokens may appear in DSH's startup URL. Keep them out of logs, screenshots, issues and test output. Do not infer the current token from an arbitrary historical log line without validating it against the exact local origin.
- Keep API keys and provider settings outside this repository. Examples use placeholders only.
- Do not edit installed official `node_modules` files; customizations belong in plugins or the desktop launcher.
- Keep the user's fixed 20px heatmap cells and visible gray empty days. A narrow window should scroll the chart rather than stretch the cells or overflow the dialog.
- When a parser cannot read a session, surface partial/unavailable statistics. Unknown prices must not become invented zero-cost usage or be mapped to an unrelated model.

## Scope of regression evidence

A successful HTTP response verifies transport, not end-to-end behavior. Separate what was checked: parsing, data correctness, authenticated API access, browser rendering, desktop navigation, and real provider inference. The suite uses no paid model inference; provider availability and account quota remain outside its coverage.
