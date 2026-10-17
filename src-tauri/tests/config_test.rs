use serde_json::Value;

fn tauri_config() -> Value {
    let raw = std::fs::read_to_string(format!("{}/tauri.conf.json", env!("CARGO_MANIFEST_DIR"))).expect("read tauri.conf.json");
    serde_json::from_str(&raw).expect("parse tauri.conf.json")
}

/// The webview renders agent output and can call powerful commands, so a
/// policy must stop injected script and remote loads.
#[test]
fn the_app_ships_with_a_strict_content_security_policy() {
    let config = tauri_config();
    let csp = config["app"]["security"]["csp"].as_str().expect("a CSP string, not null");

    assert!(csp.contains("default-src 'self'"), "{csp}");
    assert!(csp.contains("script-src 'self'"), "{csp}");
    assert!(csp.contains("object-src 'none'"), "{csp}");
    let script_src = csp.split(';').find(|d| d.trim().starts_with("script-src")).expect("script-src");
    assert!(!script_src.contains("unsafe-inline") && !script_src.contains("unsafe-eval"), "{script_src}");
    assert!(!csp.contains("https:") && !csp.contains("http: "), "no remote origins: {csp}");
}
