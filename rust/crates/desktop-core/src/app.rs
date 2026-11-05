//! The application runtime. Owns all state in Rust and exposes the two IPC
//! entry points (`invoke` / `send`) to the tao+wry shell.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};

use crate::api::ApiClient;
use crate::error::{AppError, Result};
use crate::git::GitEngine;
use crate::ipc::protocol::{Host, IpcMessage};
use crate::models::app_state::AppState;
use crate::state::dispatcher;
use crate::storage::{AppPaths, SecureStore, Storage};

/// A new channel introduced by the Rust port. Electron's renderer read
/// `AppStore` state in-process; wry has no shared memory, so Rust pushes a
/// sanitized immutable snapshot on every mutation.
pub const STATE_CHANGED: &str = "state-changed";

pub struct DesktopApp {
    pub paths: AppPaths,
    pub storage: Storage,
    pub secure: SecureStore,
    pub git: GitEngine,
    pub api: ApiClient,
    state: Mutex<AppState>,
    host: Arc<dyn Host>,
    started: Instant,
}

impl DesktopApp {
    pub fn new(host: Arc<dyn Host>) -> Result<Arc<Self>> {
        let paths = AppPaths::detect()?;
        let storage = Storage::open(paths.clone())?;
        let secure = SecureStore::new(paths.credential_dir())?;
        let api = ApiClient::new(secure.clone())?;
        let git = GitEngine::new();

        let mut state = storage.load_state()?;
        if let Ok(prefs) = std::fs::read(paths.preferences_file()) {
            if let Ok(prefs) = serde_json::from_slice(&prefs) {
                state.preferences = prefs;
            }
        }
        state.accounts = state.accounts.iter().map(|a| a.without_token()).collect();
        state.endpoint_tokens.clear();

        tracing::info!(
            git = %git.binary.to_string_lossy(),
            data = %paths.user_data.display(),
            repositories = state.repositories.len(),
            "desktop-core initialized"
        );

        Ok(Arc::new(Self {
            paths,
            storage,
            secure,
            git,
            api,
            state: Mutex::new(state),
            host,
            started: Instant::now(),
        }))
    }

    pub fn started(&self) -> Instant { self.started }

    /// Duplex IPC (`ipcRenderer.invoke`). Returns the value that resolves the
    /// JS promise, or a flattened error.
    pub fn invoke(&self, channel: &str, args: Vec<Value>) -> Result<Value> {
        let message = IpcMessage { channel: channel.to_string(), args };
        let outcome = {
            let mut state = self.lock_state()?;
            dispatcher::invoke(self, &mut state, &message)
        };
        let (value, changed) = outcome?;
        if changed {
            self.persist_and_broadcast()?;
        }
        Ok(value)
    }

    /// Simplex IPC (`ipcRenderer.send`). Fire-and-forget, but may mutate state.
    pub fn send(&self, channel: &str, args: Vec<Value>) -> Result<()> {
        let message = IpcMessage { channel: channel.to_string(), args };
        let changed = {
            let mut state = self.lock_state()?;
            dispatcher::send(self, &mut state, &message)
        }?;
        if changed {
            self.persist_and_broadcast()?;
        }
        Ok(())
    }

    /// `ipcWebContents.send` — push an event into the webview. `args` is the
    /// array of positional arguments; the JS shim spreads it back out.
    pub fn emit(&self, channel: &str, args: Vec<Value>) {
        self.host.emit(channel, Value::Array(args));
    }

    pub fn emit_value(&self, channel: &str, value: Value) {
        self.emit(channel, vec![value]);
    }

    pub fn window(&self, action: crate::ipc::protocol::WindowAction) -> Result<Value> {
        self.host.window(action)
    }

    pub fn snapshot(&self) -> Result<Value> {
        let state = self.lock_state()?;
        Ok(serde_json::to_value(state.sanitized())?)
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, AppState>> {
        self.state.lock().map_err(|_| AppError::msg("app state lock poisoned"))
    }

    fn persist_and_broadcast(&self) -> Result<()> {
        let (state, preferences) = {
            let guard = self.lock_state()?;
            (guard.sanitized(), guard.preferences.clone())
        };
        self.storage.save_state(&state)?;
        self.storage.save_preferences(&preferences)?;
        self.emit_value(STATE_CHANGED, json!(state));
        Ok(())
    }

    /// Called once the webview has loaded so the renderer can hydrate.
    pub fn broadcast_initial_state(&self) {
        match self.snapshot() {
            Ok(state) => {
                let menu = state.get("appMenu").cloned().unwrap_or(json!({}));
                self.emit_value(STATE_CHANGED, state);
                self.emit(crate::ipc::channels::event::APP_MENU, vec![menu]);
                self.emit(
                    crate::ipc::channels::event::LAUNCH_TIMING_STATS,
                    vec![json!({
                        "mainReadyTime": self.started.elapsed().as_millis() as f64,
                        "loadTime": 0.0,
                        "rendererReadyTime": 0.0
                    })],
                );
            }
            Err(e) => tracing::error!("failed to serialize initial state: {e}"),
        }
    }

    /// Route OS-level launch arguments (`--cli-open`, `--cli-clone`, and the
    /// `x-github-client://` protocol URLs) into `cli-action` / `url-action`.
    pub fn handle_launch_args(&self, args: &[String]) {
        for arg in args {
            if let Some(path) = arg.strip_prefix("--cli-open=") {
                self.emit(
                    crate::ipc::channels::event::CLI_ACTION,
                    vec![json!({ "kind": "open-repository", "path": path })],
                );
            } else if let Some(url) = arg.strip_prefix("--cli-clone=") {
                self.emit(
                    crate::ipc::channels::event::CLI_ACTION,
                    vec![json!({ "kind": "clone-url", "url": url })],
                );
            } else if arg.starts_with("x-github-client://") || arg.starts_with("github-mac://") {
                let action = parse_app_url(arg);
                self.emit(crate::ipc::channels::event::URL_ACTION, vec![action]);
            }
        }
    }
}

/// Port of `app/src/lib/parse-app-url.ts`.
pub fn parse_app_url(url: &str) -> Value {
    let raw = url.split("://").nth(1).unwrap_or("");
    let (kind, rest) = raw.split_once('/').unwrap_or((raw, ""));
    let mut action = serde_json::Map::new();
    action.insert("kind".into(), json!(kind));
    action.insert("raw".into(), json!(url));
    for (key, value) in rest.split('&').filter_map(|pair| pair.split_once('=')) {
        action.insert(key.to_string(), json!(value));
    }
    Value::Object(action)
}
