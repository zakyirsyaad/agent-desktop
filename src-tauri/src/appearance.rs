//! Maps the saved appearance setting to the native window theme.

use tauri::Theme;

/// The theme to force for a saved appearance value, or `None` to follow the
/// system. Only the exact values `light` and `dark` force a theme.
pub fn theme_for(appearance: &str) -> Option<Theme> {
    match appearance {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn light_and_dark_force_a_theme() {
        assert_eq!(theme_for("light"), Some(Theme::Light));
        assert_eq!(theme_for("dark"), Some(Theme::Dark));
    }

    #[test]
    fn everything_else_follows_the_system() {
        for value in ["system", "", "LIGHT", "sepia"] {
            assert_eq!(theme_for(value), None, "{value:?}");
        }
    }
}
