use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine};
use zorvo_lib::registry::history::VersionHistory;
use zorvo_lib::registry::icons::{
    icon_data_urls, is_allowed_icon_url, is_svg, refresh_icons, IconSource,
};
use zorvo_lib::registry::schema::{Distribution, RegistryEntry};
use zorvo_lib::registry::Catalog;

const URL_A: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/a.svg";
const SVG: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>";

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("zorvo-icons-{tag}-{}-{unique}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn source(id: &str, version: &str, url: &str) -> IconSource {
    IconSource {
        id: id.into(),
        version: version.into(),
        url: url.into(),
    }
}

fn data_url(svg: &str) -> String {
    format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg))
}

/// A fetch that records the URLs it was asked for and answers with `reply`.
fn recording<'a>(
    calls: &'a RefCell<Vec<String>>,
    reply: Result<&'static str, &'static str>,
) -> impl Fn(&str) -> Result<String, String> + 'a {
    move |url| {
        calls.borrow_mut().push(url.to_string());
        reply.map(String::from).map_err(String::from)
    }
}

#[test]
fn only_cdn_https_urls_are_allowed() {
    assert!(is_allowed_icon_url(URL_A));
    assert!(!is_allowed_icon_url(
        "http://cdn.agentclientprotocol.com/registry/v1/latest/a.svg"
    ));
    assert!(!is_allowed_icon_url("https://evil.example/a.svg"));
    assert!(!is_allowed_icon_url(
        "https://cdn.agentclientprotocol.com.evil.example/a.svg"
    ));
}

#[test]
fn is_svg_accepts_svg_with_an_xml_prolog() {
    assert!(is_svg(SVG));
    assert!(is_svg(
        "  <?xml version=\"1.0\"?>\n<svg viewBox=\"0 0 1 1\"></svg>"
    ));
    assert!(!is_svg("<html>"));
    assert!(!is_svg("\u{89}PNG"));
    assert!(!is_svg(""));
}

#[test]
fn is_svg_agrees_with_the_script_on_comments_and_self_closing_tags() {
    assert!(is_svg("<svg/>"));
    assert!(!is_svg("<svgx>"));
    assert!(!is_svg("<!-- logo --><svg></svg>"));
    assert!(!is_svg("<?xml version=\"1.0\"?><!-- logo --><svg></svg>"));
}

#[test]
fn a_new_icon_is_downloaded_and_cached() {
    let dir = TempDir::new("new");
    let calls = RefCell::new(Vec::new());

    let changed = refresh_icons(
        &dir.0,
        &[source("a", "1.0.0", URL_A)],
        recording(&calls, Ok(SVG)),
    );

    assert!(changed);
    assert_eq!(*calls.borrow(), vec![URL_A.to_string()]);
    assert_eq!(std::fs::read_to_string(dir.0.join("a.svg")).unwrap(), SVG);
    let urls = icon_data_urls(Some(&dir.0), "{}");
    assert_eq!(urls.get("a"), Some(&data_url(SVG)));
}

#[test]
fn an_unchanged_icon_is_not_downloaded_again() {
    let dir = TempDir::new("same");
    let sources = [source("a", "1.0.0", URL_A)];
    refresh_icons(&dir.0, &sources, |_| Ok(SVG.into()));
    let calls = RefCell::new(Vec::new());

    let changed = refresh_icons(&dir.0, &sources, recording(&calls, Ok(SVG)));

    assert!(!changed);
    assert!(calls.borrow().is_empty());
}

#[test]
fn a_changed_version_downloads_again() {
    let dir = TempDir::new("version");
    refresh_icons(&dir.0, &[source("a", "1.0.0", URL_A)], |_| Ok(SVG.into()));
    let newer = "<svg><path/></svg>";
    let calls = RefCell::new(Vec::new());

    let changed = refresh_icons(
        &dir.0,
        &[source("a", "1.1.0", URL_A)],
        recording(&calls, Ok(newer)),
    );

    assert!(changed);
    assert_eq!(calls.borrow().len(), 1);
    assert_eq!(
        icon_data_urls(Some(&dir.0), "{}").get("a"),
        Some(&data_url(newer))
    );
}

#[test]
fn a_failed_or_non_svg_download_keeps_the_old_copy() {
    let dir = TempDir::new("failed");
    refresh_icons(&dir.0, &[source("a", "1.0.0", URL_A)], |_| Ok(SVG.into()));
    let next = [source("a", "1.1.0", URL_A)];
    let calls = RefCell::new(Vec::new());

    assert!(!refresh_icons(
        &dir.0,
        &next,
        recording(&calls, Err("offline"))
    ));
    assert!(!refresh_icons(
        &dir.0,
        &next,
        recording(&calls, Ok("<html>"))
    ));

    assert_eq!(calls.borrow().len(), 2);
    assert_eq!(std::fs::read_to_string(dir.0.join("a.svg")).unwrap(), SVG);
    assert_eq!(
        icon_data_urls(Some(&dir.0), "{}").get("a"),
        Some(&data_url(SVG))
    );
}

#[test]
fn a_disallowed_url_is_never_fetched() {
    let dir = TempDir::new("disallowed");
    let calls = RefCell::new(Vec::new());

    let changed = refresh_icons(
        &dir.0,
        &[source("a", "1.0.0", "https://evil.example/a.svg")],
        recording(&calls, Ok(SVG)),
    );

    assert!(!changed);
    assert!(calls.borrow().is_empty());
    assert!(!dir.0.join("a.svg").exists());
}

#[test]
fn an_id_that_is_not_a_file_name_is_never_fetched() {
    let dir = TempDir::new("badid");
    let calls = RefCell::new(Vec::new());

    let changed = refresh_icons(
        &dir.0,
        &[source("../escape", "1.0.0", URL_A)],
        recording(&calls, Ok(SVG)),
    );

    assert!(!changed);
    assert!(calls.borrow().is_empty());
}

#[test]
fn a_corrupt_cache_is_treated_as_empty() {
    let dir = TempDir::new("corrupt");
    std::fs::write(dir.0.join("index.json"), "nope").unwrap();
    std::fs::write(dir.0.join("b.svg"), "<html>").unwrap();
    let calls = RefCell::new(Vec::new());

    let changed = refresh_icons(
        &dir.0,
        &[source("a", "1.0.0", URL_A)],
        recording(&calls, Ok(SVG)),
    );

    assert!(changed);
    assert_eq!(calls.borrow().len(), 1);
    assert!(!icon_data_urls(Some(&dir.0), "{}").contains_key("b"));
}

#[test]
fn bundled_icons_fill_ids_without_a_cached_copy() {
    let dir = TempDir::new("bundled");
    refresh_icons(&dir.0, &[source("a", "1.0.0", URL_A)], |_| Ok(SVG.into()));
    let bundled = serde_json::json!({ "a": "<svg id=\"old\"></svg>", "b": SVG, "c": "<html>" });

    let urls = icon_data_urls(Some(&dir.0), &bundled.to_string());

    assert_eq!(urls.get("a"), Some(&data_url(SVG)));
    assert_eq!(urls.get("b"), Some(&data_url(SVG)));
    assert!(!urls.contains_key("c"));
    assert_eq!(icon_data_urls(None, &bundled.to_string()).len(), 2);
}

fn entry_with_icon(id: &str, version: &str, icon: Option<&str>) -> RegistryEntry {
    RegistryEntry {
        id: id.to_string(),
        name: id.to_string(),
        version: version.to_string(),
        description: None,
        icon: icon.map(String::from),
        distribution: Distribution::Npx {
            package: format!("{id}-pkg@{version}"),
            args: vec![],
            env: BTreeMap::new(),
        },
    }
}

#[test]
fn the_catalog_caches_the_listed_versions_icons_after_a_fetch() {
    let dir = TempDir::new("catalog");
    let catalog = Catalog::open(dir.0.clone(), &VersionHistory::default().to_json());
    assert!(
        catalog.icon_sources().is_empty(),
        "nothing is listed before a fetch"
    );
    let registry = serde_json::json!({
        "version": "1.0.0",
        "agents": [
            entry_with_icon("a", "1.0.0", Some(URL_A)),
            entry_with_icon("noicon", "1.0.0", None),
        ],
    });
    catalog
        .refresh(|| Ok(registry.to_string()), 1_790_000_000)
        .unwrap();

    assert_eq!(catalog.icon_sources(), vec![source("a", "1.0.0", URL_A)]);
    assert!(catalog.refresh_icons(|_| Ok(SVG.into())));
    assert_eq!(catalog.icon_data_urls().get("a"), Some(&data_url(SVG)));
}

#[test]
fn a_bundle_only_catalog_never_downloads_icons() {
    let catalog = Catalog::bundled(&VersionHistory::default().to_json());
    let calls = RefCell::new(Vec::new());

    assert!(!catalog.refresh_icons(recording(&calls, Ok(SVG))));
    assert!(calls.borrow().is_empty());
}

#[test]
fn every_shipped_icon_is_a_small_svg() {
    use zorvo_lib::registry::icons::{BUNDLED_ICONS, MAX_ICON_BYTES};
    let icons: BTreeMap<String, String> = serde_json::from_str(BUNDLED_ICONS).unwrap();
    assert!(!icons.is_empty());
    for (id, svg) in &icons {
        assert!(is_svg(svg) && svg.len() as u64 <= MAX_ICON_BYTES, "{id}");
    }
    assert_eq!(icon_data_urls(None, BUNDLED_ICONS).len(), icons.len());
}

#[test]
fn a_missing_cached_file_is_downloaded_again() {
    let dir = TempDir::new("missing");
    let sources = [source("a", "1.0.0", URL_A)];
    refresh_icons(&dir.0, &sources, |_| Ok(SVG.into()));
    std::fs::remove_file(dir.0.join("a.svg")).unwrap();
    let calls = RefCell::new(Vec::new());

    assert!(refresh_icons(&dir.0, &sources, recording(&calls, Ok(SVG))));

    assert_eq!(calls.borrow().len(), 1);
    assert_eq!(
        icon_data_urls(Some(&dir.0), "{}").get("a"),
        Some(&data_url(SVG))
    );
}

#[test]
fn a_cached_file_that_is_not_svg_is_downloaded_again() {
    let dir = TempDir::new("notsvg");
    let sources = [source("a", "1.0.0", URL_A)];
    refresh_icons(&dir.0, &sources, |_| Ok(SVG.into()));
    std::fs::write(dir.0.join("a.svg"), "<html>").unwrap();
    let calls = RefCell::new(Vec::new());

    assert!(refresh_icons(&dir.0, &sources, recording(&calls, Ok(SVG))));

    assert_eq!(calls.borrow().len(), 1);
    assert_eq!(std::fs::read_to_string(dir.0.join("a.svg")).unwrap(), SVG);
}
