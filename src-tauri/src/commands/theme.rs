//! `get_theme` command — hands the resolved theme to a window as it starts
//! (requirements.md #56 契約 3, docs/theme-architecture.md (j)).
//!
//! `src/routes/+layout.ts` awaits it before `+page.svelte` is drawn, so the
//! first paint already carries the user's theme. The theme was resolved once
//! for the app (`theme::ThemeState`); a new window gets the same value without
//! reading the files again. Later changes arrive as `theme_changed`.

use tauri::State;

use crate::theme::{ResolvedTheme, ThemeState};

#[tauri::command]
pub fn get_theme(state: State<'_, ThemeState>) -> ResolvedTheme {
    state.current()
}
