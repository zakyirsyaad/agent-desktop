//! Safety check for the link of a URL-mode elicitation.

use serde::Serialize;
use url::{Host, Url};

/// The one message shown for every link Zorvo will not open.
const BLOCKED_MESSAGE: &str = "Zorvo opens only https links, or http on this Mac.";

/// A sign that a link may be trying to look like another site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UrlWarning {
    Punycode,
    IpAddress,
    UserInfo,
}

/// What Zorvo found out about a link before showing it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlCheck {
    /// The link as parsed and normalised, or `None` when it did not parse.
    pub url: Option<String>,
    /// The host in its ASCII form, or empty when the link has none.
    pub host: String,
    /// Why the link may not be opened, or `None` when it may.
    pub blocked: Option<String>,
    pub warnings: Vec<UrlWarning>,
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// Checks a link: only https, or http to this Mac, may be opened.
pub fn check_url(url: &str) -> UrlCheck {
    let Ok(parsed) = Url::parse(url) else {
        return UrlCheck {
            url: None,
            host: String::new(),
            blocked: Some(BLOCKED_MESSAGE.to_string()),
            warnings: Vec::new(),
        };
    };
    let host = parsed.host_str().unwrap_or("").to_string();
    let allowed = match parsed.scheme() {
        "https" => true,
        "http" => is_loopback(&host),
        _ => false,
    };

    let mut warnings = Vec::new();
    match parsed.host() {
        Some(Host::Domain(domain)) => {
            if domain.split('.').any(|label| label.starts_with("xn--")) {
                warnings.push(UrlWarning::Punycode);
            }
        }
        Some(Host::Ipv4(_) | Host::Ipv6(_)) if !is_loopback(&host) => {
            warnings.push(UrlWarning::IpAddress);
        }
        _ => {}
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        warnings.push(UrlWarning::UserInfo);
    }

    UrlCheck {
        url: Some(parsed.to_string()),
        host,
        blocked: (!allowed).then(|| BLOCKED_MESSAGE.to_string()),
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_https_and_loopback_http() {
        for url in [
            "https://x.dev/a",
            "http://localhost:3000/cb",
            "http://127.0.0.1/cb",
            "http://[::1]:8080/",
        ] {
            assert_eq!(check_url(url).blocked, None, "{url}");
        }
    }

    #[test]
    fn blocks_everything_else() {
        for url in [
            "http://example.com",
            "file:///etc/passwd",
            "mailto:a@b.c",
            "javascript:alert(1)",
            "vscode://x",
            "not a url",
        ] {
            assert!(check_url(url).blocked.is_some(), "{url}");
        }
    }

    #[test]
    fn warns_about_lookalike_hosts() {
        let punycode = check_url("https://xn--pple-43d.com/");
        assert_eq!(punycode.warnings, vec![UrlWarning::Punycode]);
        assert_eq!(punycode.host, "xn--pple-43d.com");
        assert_eq!(
            check_url("https://93.184.216.34/").warnings,
            vec![UrlWarning::IpAddress]
        );
        assert_eq!(
            check_url("https://user@example.com/").warnings,
            vec![UrlWarning::UserInfo]
        );
        assert!(check_url("https://example.com/").warnings.is_empty());
        assert!(check_url("http://127.0.0.1/cb").warnings.is_empty());
    }

    #[test]
    fn reads_a_unicode_host_as_punycode() {
        let check = check_url("https://аpple.com/");
        assert!(check.host.starts_with("xn--"));
        assert_eq!(check.warnings, vec![UrlWarning::Punycode]);
    }
}
