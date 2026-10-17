use serde_json::Value;

fn tauri_config() -> Value {
    let raw = std::fs::read_to_string(format!("{}/tauri.conf.json", env!("CARGO_MANIFEST_DIR")))
        .expect("read tauri.conf.json");
    serde_json::from_str(&raw).expect("parse tauri.conf.json")
}

/// The webview renders agent output and can call powerful commands, so a
/// policy must stop injected script and remote loads.
#[test]
fn the_app_ships_with_a_strict_content_security_policy() {
    let config = tauri_config();
    let csp = config["app"]["security"]["csp"]
        .as_str()
        .expect("a CSP string, not null");

    assert!(csp.contains("default-src 'self'"), "{csp}");
    assert!(csp.contains("script-src 'self'"), "{csp}");
    assert!(csp.contains("object-src 'none'"), "{csp}");
    let script_src = csp
        .split(';')
        .find(|d| d.trim().starts_with("script-src"))
        .expect("script-src");
    assert!(
        !script_src.contains("unsafe-inline") && !script_src.contains("unsafe-eval"),
        "{script_src}"
    );
    assert!(
        !csp.contains("https:") && !csp.contains("http: "),
        "no remote origins: {csp}"
    );
}

/// Tauri adds hashes/nonces to the CSP of bundled assets; in `style-src` they
/// would void `'unsafe-inline'`, which xterm's injected <style> needs.
#[test]
fn inline_styles_stay_allowed_in_the_bundled_app() {
    let config = tauri_config();
    let security = &config["app"]["security"];

    let untouched: Vec<&str> = security["dangerousDisableAssetCspModification"]
        .as_array()
        .expect("a list of directives Tauri must not modify")
        .iter()
        .filter_map(|d| d.as_str())
        .collect();

    assert_eq!(
        untouched,
        ["style-src"],
        "only style-src: script-src keeps Tauri's nonces"
    );
    assert!(security["csp"]
        .as_str()
        .unwrap()
        .contains("style-src 'self' 'unsafe-inline'"));
}
