//! Native application menu built with `muda`.
//!
//! Electron's `Menu.buildFromTemplate` lived in `app/src/main-process/menu`.
//! In the Rust port the same [`MENU_EVENTS`] identifiers are used as muda menu
//! ids, so a click is forwarded verbatim as a `menu-event` push to the webview.
//! On platforms where a native menu bar is not available the web frontend
//! renders the equivalent menu from the `app-menu` state snapshot instead.

use tao::event_loop::EventLoopProxy;

use muda::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu};

use crate::host::AppEvent;

fn item(id: &str, label: &str) -> MenuItem {
    MenuItem::with_id(MenuId::new(id), label, true, None)
}

/// Build the menu and route clicks into the tao event loop.
pub fn install(proxy: EventLoopProxy<AppEvent>) -> Option<Menu> {
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let _ = proxy.send_event(AppEvent::NativeMenu(event.id.0.clone()));
    }));

    let build = (|| -> muda::Result<Menu> {
        let file = Submenu::with_id_and_items(
            MenuId::new("file-menu"),
            "File",
            true,
            &[
                &item("add-local-repository", "Add Local Repository…"),
                &item("create-repository", "New Repository…"),
                &item("clone-repository", "Clone Repository…"),
                &PredefinedMenuItem::separator(),
                &item("show-preferences", "Preferences"),
                &PredefinedMenuItem::separator(),
                &item("quit-app", "Quit"),
            ],
        )?;

        let repository = Submenu::with_id_and_items(
            MenuId::new("repository-menu"),
            "Repository",
            true,
            &[
                &item("show-changes", "Changes"),
                &item("show-history", "History"),
                &item("show-branches", "Branches"),
                &PredefinedMenuItem::separator(),
                &item("fetch", "Fetch"),
                &item("pull", "Pull"),
                &item("push", "Push"),
                &PredefinedMenuItem::separator(),
                &item("open-working-directory", "Open Working Directory"),
                &item("view-repository-on-github", "View on GitHub"),
                &item("remove-repository", "Remove"),
            ],
        )?;

        let branch = Submenu::with_id_and_items(
            MenuId::new("branch-menu"),
            "Branch",
            true,
            &[
                &item("create-branch", "New Branch…"),
                &item("rename-branch", "Rename…"),
                &item("delete-branch", "Delete…"),
                &PredefinedMenuItem::separator(),
                &item("merge-branch", "Merge into Current Branch…"),
                &item("rebase-branch", "Rebase Current Branch…"),
                &item("compare-to-branch", "Compare to Branch"),
                &PredefinedMenuItem::separator(),
                &item("stash-all-changes", "Stash All Changes"),
            ],
        )?;

        let view = Submenu::with_id_and_items(
            MenuId::new("view-menu"),
            "View",
            true,
            &[
                &item("select-all", "Select All"),
                &item("find-text", "Find"),
                &item("toggle-changes-filter", "Toggle Changes Filter"),
                &PredefinedMenuItem::separator(),
                &item("show-about", "About GitHub Desktop"),
            ],
        )?;

        Menu::with_items(&[&file, &repository, &branch, &view])
    })();

    match build {
        Ok(menu) => Some(menu),
        Err(error) => {
            tracing::warn!(%error, "native menu unavailable; using web menu bar");
            None
        }
    }
}

/// Attach the menu to the OS window. Windows uses the HWND hook; macOS uses
/// the shared NSApp menu; Linux relies on the web-rendered menu bar.
pub fn attach(menu: &Menu, window: &tao::window::Window) {
    #[cfg(target_os = "windows")]
    {
        use tao::platform::windows::WindowExtWindows;
        let hwnd = window.hwnd();
        if let Err(error) = unsafe { menu.init_for_hwnd(hwnd) } {
            tracing::warn!(%error, "could not attach native menu to HWND");
        }
    }

    #[cfg(target_os = "macos")]
    {
        menu.init_for_nsapp();
        let _ = window;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (menu, window);
    }
}
