# Electron → `tao` + `wry` migration (Rust-only backend)

This branch replaces the Electron main process, the Node-enabled renderer and
all TypeScript backend code with a Rust workspace. The window is created by
[`tao`](https://crates.io/crates/tao), the web content is hosted by
[`wry`](https://crates.io/crates/wry), and **Tauri is not used** — there is no
Tauri runtime, no `tauri.conf.json`, no `#[tauri::command]` and no Node/Electron
process. Everything that is not the user interface is Rust; the UI is plain
HTML/CSS/JavaScript.

## Why this shape

The original renderer ran with `nodeIntegration: true` and
`contextIsolation: false`. It imported `fs`, `path`, `dugite`, `keytar`,
`api.ts` and `electron` directly, so the "main process" boundary was largely
notional. A `wry` webview has no Node runtime, so those capabilities had to
become explicit commands owned by Rust. The migration therefore splits the
application in two:

| Crate | Responsibility | GUI dependencies |
|-------|----------------|------------------|
| `rust/crates/desktop-core` | models, git engine, storage, GitHub API, platform helpers, app state, IPC dispatch | **none** |
| `rust/crates/desktop-app` | tao window/event loop, wry webview, custom protocol, native menu, dialogs, clipboard | tao, wry, muda, rfd, arboard |

`desktop-core` talks to the shell exclusively through the `Host` trait
(`emit` and `window`). That keeps the domain layer unit-testable without a
window or a display server — `cargo test -p desktop-core` runs headless.

## Layout

```
rust/
├── Cargo.toml                       workspace: two crates, no Tauri
├── crates/desktop-core/src/
│   ├── models/                      app/src/models/** (61 TS files)
│   ├── git/                         app/src/lib/git/** + dugite (std::process::Command)
│   ├── storage/                     Dexie + localStorage + keytar → JSON files + DPAPI
│   ├── api/                         api.ts / http.ts → reqwest::blocking
│   ├── platform/                    shell, clipboard, theme, notifications, proxy, CLI, updater
│   ├── ipc/channels.rs              79 Electron channels, transcribed verbatim
│   ├── ipc/protocol.rs              wire frames, WindowAction, Host
│   ├── state/dispatcher.rs          ipcMain handlers → Rust dispatch
│   ├── state/commands.rs            desktop.* domain commands
│   └── app.rs                       owns AppState, invoke/send/emit
└── crates/desktop-app/
    ├── src/main.rs                  tao event loop + wry webview
    ├── src/host.rs                  Host implementation / event bridge
    ├── src/bridge.rs                desktop:// protocol, IPC worker, init script
    ├── src/actions.rs               WindowAction on the UI thread
    ├── src/menu.rs                  muda native menu
    └── web/                         the entire frontend (embedded with include_bytes!)
```

The legacy `app/`, `script/` and `package.json` trees are retained in this
branch for reference and review; the Rust binary does not read or execute any
of them.

## The IPC bridge

| Electron | Replacement |
|----------|-------------|
| `ipcRenderer.invoke` | correlated `window.ipc.postMessage` → Rust worker → `evaluate_script("__desktop.resolve(…)")` |
| `ipcRenderer.send` | `window.ipc.postMessage` → Rust worker → `DesktopApp::send` |
| `ipcWebContents.send` | `Host::emit` → outbox → `evaluate_script("__desktop.emit(…)")` |
| `ipcRenderer.sendSync` | promise-returning `sendSync` (wry has no synchronous IPC; the three `will-quit*` channels must be awaited) |
| `file://index.html` + Node integration | `desktop://localhost/index.html` custom protocol, no Node |
| native menu (`Menu.buildFromTemplate`) | `muda`, ids equal to the original `MenuEvent` strings |
| `dialog` / `clipboard` / `shell` | `rfd` / `arboard` / `platform` module, all on Rust |

An initialization script (`web/ipc-shim.js`) installs an
`ipcRenderer`-compatible object plus `window.desktop`. A minimal
`require('electron')` shim is provided for a browser build of the legacy
renderer; any other Node module throws with a message pointing at the
`desktop.*` command that should be used instead.

`invoke` deliberately does not use `fetch`: custom schemes have
platform-specific origins on WebView2/WKWebView, which makes CORS fragile.
A `desktop://localhost/__invoke` POST endpoint is nevertheless provided for
headless smoke tests and non-webview clients.

### Channels

* 28 duplex channels (`ipcMain.handle`)
* 31 inbound simplex channels (`ipcMain.on`)
* 20 push-only main-process → renderer channels
* 79 total legacy channels, all named in `ipc/channels.rs` and covered by a
  unit test
* plus the `desktop.*` namespace for capabilities that used to be direct
  renderer imports: repository management, status/log/refs/diff, stage,
  commit, fetch/pull/push/clone, branch/stash/merge/rebase/cherry-pick/revert,
  tags/remotes/config, accounts and GitHub API calls, preferences and dialogs.

### State ownership

Electron's `AppStore` lived in the renderer. Here `AppState` is owned by
`DesktopApp` behind a mutex. Mutations persist atomically to JSON and push a
sanitized `state-changed` snapshot. Account tokens and `endpointTokens` are
**never** serialized into a snapshot (unit-tested). Secrets live in
DPAPI-protected credential files on Windows via `SecureStore`.

Events emitted before the renderer subscribes are buffered in the host outbox
and replayed in order after `renderer-ready`, so no initial state is lost.

## Build and run

```bash
cd rust
cargo build --workspace
cargo test  --workspace

# headless smoke test (no window / no display server)
./target/debug/github-desktop-rs --self-test

# launch the GUI
./target/debug/github-desktop-rs
```

CLI options: `--version`, `--help`, `--self-test`, `--cli-open=<path>`,
`--cli-clone=<url>`. Any `x-github-client://` / `github-mac://` argument is
forwarded to the web layer as a `url-action` event. Set `RUST_LOG=debug` for
verbose tracing.

Requirements: Rust 1.85+, a system `git`, and the platform webview runtime
(WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux). On Linux,
`pkg-config` and the WebKitGTK development packages are required.

## Scope and known limitations

This is a working end-to-end replacement of the application shell and backend,
not a line-by-line rewrite of all 490 React UI components. The shipped web
frontend implements the primary flows (repository list/add/clone/select,
status, staging, commit, diff, history, branches, fetch/pull/push, menus,
dialogs, sign-in, preferences). The following Electron-era features remain
explicitly out of scope and are surfaced as `NotImplemented` rather than
silently dropped:

* interactive rebase, conflict resolution UI, LFS, submodule management;
* the full auto-updater (Squirrel / Darwin update flow) — `check-for-updates`
  is a no-op stub;
* OAuth device flow (sign-in currently accepts a personal access token);
* the complete web-rendered equivalent of every preferences pane and the
  tutorial repository flow;
* crash-window / error-reporting UI.

The `desktop.*` command surface is intentionally additive, so those features
can be ported incrementally without changing the transport.

## Security notes

* No `nodeIntegration`, no `file://` origin, no remote code loading.
* A navigation handler only allows `desktop://` (and its WebView2 origin
  equivalent) plus `about:` URLs.
* The custom protocol rejects path traversal (`. .`, `\`, `:`).
* A restrictive CSP is set in `web/index.html`.
* Tokens never cross into the webview; they are DPAPI-protected at rest.
* JSON state is written via a temp file + rename for atomicity.
