//! Re-checks submitted form content against the agent's own schema.

use super::{Choice, Field, FieldKind};
use regex::RegexBuilder;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Error message per field name. A message never contains the submitted value.
pub type FieldErrors = BTreeMap<String, String>;

/// Longest pattern the backend compiles; longer ones are skipped.
const MAX_PATTERN_LEN: usize = 1000;
/// Memory cap for a compiled pattern and its matcher cache.
const REGEX_SIZE_LIMIT: usize = 1 << 20;

const REQUIRED: &str = "This field is required.";
const UNSUPPORTED: &str = "Zorvo cannot show this field.";
const NOT_AN_OPTION: &str = "Pick one of the options.";

/// Checks `content` against `fields`. On success returns an object with only
/// the known fields that were filled in.
pub fn validate(fields: &[Field], content: &Value) -> Result<Value, FieldErrors> {
    let mut clean = Map::new();
    let mut errors = FieldErrors::new();
    for field in fields {
        if matches!(field.kind, FieldKind::Unsupported { .. }) {
            errors.insert(field.name.clone(), UNSUPPORTED.to_string());
            continue;
        }
        match content.get(&field.name).filter(|value| !is_blank(value)) {
            None if field.required => {
                errors.insert(field.name.clone(), REQUIRED.to_string());
            }
            None => {}
            Some(value) => match check(&field.kind, value) {
                Ok(()) => {
                    clean.insert(field.name.clone(), value.clone());
                }
                Err(message) => {
                    errors.insert(field.name.clone(), message);
                }
            },
        }
    }
    if errors.is_empty() {
        Ok(Value::Object(clean))
    } else {
        Err(errors)
    }
}

/// Null and `""` count as not filled in.
fn is_blank(value: &Value) -> bool {
    value.is_null() || value.as_str() == Some("")
}

fn check(kind: &FieldKind, value: &Value) -> Result<(), String> {
    match kind {
        FieldKind::Text {
            format,
            min_length,
            max_length,
            pattern,
        } => check_text(value, format.as_deref(), *min_length, *max_length, pattern),
        FieldKind::Number {
            integer,
            minimum,
            maximum,
        } => check_number(value, *integer, *minimum, *maximum),
        FieldKind::Boolean => match value {
            Value::Bool(_) => Ok(()),
            _ => Err("Use yes or no.".to_string()),
        },
        FieldKind::Select { options } => match value.as_str() {
            Some(chosen) if is_option(options, chosen) => Ok(()),
            _ => Err(NOT_AN_OPTION.to_string()),
        },
        FieldKind::MultiSelect {
            options,
            min_items,
            max_items,
        } => check_multi(value, options, *min_items, *max_items),
        FieldKind::Unsupported { .. } => Err(UNSUPPORTED.to_string()),
    }
}

fn is_option(options: &[Choice], chosen: &str) -> bool {
    options.iter().any(|option| option.value == chosen)
}

fn check_text(
    value: &Value,
    format: Option<&str>,
    min_length: Option<u64>,
    max_length: Option<u64>,
    pattern: &Option<String>,
) -> Result<(), String> {
    let Some(text) = value.as_str() else {
        return Err("Use the format the agent asked for.".to_string());
    };
    let length = text.chars().count() as u64;
    if let Some(min) = min_length.filter(|min| length < *min) {
        return Err(format!("Use at least {min} characters."));
    }
    if let Some(max) = max_length.filter(|max| length > *max) {
        return Err(format!("Use at most {max} characters."));
    }
    if let Some((valid, message)) = format.and_then(format_check) {
        if !valid(text) {
            return Err(message.to_string());
        }
    }
    match pattern.as_deref().and_then(compile) {
        Some(regex) if !regex.is_match(text) => {
            Err("Use the format the agent asked for.".to_string())
        }
        _ => Ok(()),
    }
}

/// A format check and the message shown when it fails.
type FormatCheck = (fn(&str) -> bool, &'static str);

/// The checker and message for a known `format`. Other formats are only
/// annotations and are not checked.
fn format_check(format: &str) -> Option<FormatCheck> {
    match format {
        "email" => Some((is_email, "Use an email address.")),
        "uri" => Some((is_uri, "Use a full web address.")),
        "date" => Some((is_date, "Use a date.")),
        "date-time" => Some((is_date_time, "Use a date and time.")),
        _ => None,
    }
}

/// Compiles an agent's pattern with size limits. `None` when it is too long or
/// the regex engine cannot compile it, so such a pattern is skipped.
fn compile(pattern: &str) -> Option<regex::Regex> {
    if pattern.len() > MAX_PATTERN_LEN {
        return None;
    }
    RegexBuilder::new(pattern)
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_SIZE_LIMIT)
        .build()
        .ok()
}

fn check_number(
    value: &Value,
    integer: bool,
    minimum: Option<f64>,
    maximum: Option<f64>,
) -> Result<(), String> {
    let Some(number) = value.as_f64() else {
        return Err("Use a number.".to_string());
    };
    if integer && number.fract() != 0.0 {
        return Err("Use a whole number.".to_string());
    }
    if let Some(min) = minimum.filter(|min| number < *min) {
        return Err(format!("Use {min} or more."));
    }
    if let Some(max) = maximum.filter(|max| number > *max) {
        return Err(format!("Use {max} or less."));
    }
    Ok(())
}

fn check_multi(
    value: &Value,
    options: &[Choice],
    min_items: Option<u64>,
    max_items: Option<u64>,
) -> Result<(), String> {
    let Some(items) = value.as_array() else {
        return Err(NOT_AN_OPTION.to_string());
    };
    if !items.iter().all(|item| {
        item.as_str()
            .is_some_and(|chosen| is_option(options, chosen))
    }) {
        return Err(NOT_AN_OPTION.to_string());
    }
    let count = items.len() as u64;
    if let Some(min) = min_items.filter(|min| count < *min) {
        return Err(format!("Pick at least {min}."));
    }
    if let Some(max) = max_items.filter(|max| count > *max) {
        return Err(format!("Pick at most {max}."));
    }
    Ok(())
}

fn is_email(text: &str) -> bool {
    let Some((local, domain)) = text.split_once('@') else {
        return false;
    };
    !text.contains(char::is_whitespace)
        && !local.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
}

fn is_uri(text: &str) -> bool {
    let Some((scheme, rest)) = text.split_once("://") else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        && !rest.is_empty()
        && !text.contains(char::is_whitespace)
}

/// `n` ASCII digits as a number, or `None`.
fn digits(text: &str, n: usize) -> Option<u32> {
    (text.len() == n && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// `YYYY-MM-DD` with a month of 1-12 and a day of 1-31.
fn is_date(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    let [year, month, day] = parts.as_slice() else {
        return false;
    };
    digits(year, 4).is_some()
        && digits(month, 2).is_some_and(|m| (1..=12).contains(&m))
        && digits(day, 2).is_some_and(|d| (1..=31).contains(&d))
}

/// RFC 3339: a date, `T`, `HH:MM:SS` with optional fraction, then `Z` or `±HH:MM`.
fn is_date_time(text: &str) -> bool {
    let Some((date, time)) = text.split_once(['T', 't']) else {
        return false;
    };
    let (clock, offset) = match time.strip_suffix(['Z', 'z']) {
        Some(clock) => (clock, None),
        None => match time.rfind(['+', '-']) {
            Some(at) => (&time[..at], Some(&time[at + 1..])),
            None => return false,
        },
    };
    is_date(date) && is_clock(clock) && offset.is_none_or(is_offset)
}

fn is_clock(text: &str) -> bool {
    let (whole, fraction) = match text.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (text, None),
    };
    if fraction.is_some_and(|f| f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    let parts: Vec<&str> = whole.split(':').collect();
    let [hour, minute, second] = parts.as_slice() else {
        return false;
    };
    digits(hour, 2).is_some_and(|h| h <= 23)
        && digits(minute, 2).is_some_and(|m| m <= 59)
        && digits(second, 2).is_some_and(|s| s <= 60)
}

fn is_offset(text: &str) -> bool {
    let Some((hour, minute)) = text.split_once(':') else {
        return false;
    };
    digits(hour, 2).is_some_and(|h| h <= 23) && digits(minute, 2).is_some_and(|m| m <= 59)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::elicitation::{Choice, Field, FieldKind};
    use serde_json::{json, Value};
    use std::time::{Duration, Instant};

    fn field(name: &str, required: bool, kind: FieldKind) -> Field {
        Field {
            name: name.into(),
            title: None,
            description: None,
            required,
            kind,
            default: None,
        }
    }

    fn text(
        format: Option<&str>,
        min: Option<u64>,
        max: Option<u64>,
        pat: Option<&str>,
    ) -> FieldKind {
        FieldKind::Text {
            format: format.map(Into::into),
            min_length: min,
            max_length: max,
            pattern: pat.map(Into::into),
        }
    }

    fn number(integer: bool, minimum: Option<f64>, maximum: Option<f64>) -> FieldKind {
        FieldKind::Number {
            integer,
            minimum,
            maximum,
        }
    }

    fn choices() -> Vec<Choice> {
        ["a", "b"]
            .iter()
            .map(|v| Choice {
                value: (*v).into(),
                title: (*v).into(),
                description: None,
            })
            .collect()
    }

    fn multi(min_items: Option<u64>, max_items: Option<u64>) -> FieldKind {
        FieldKind::MultiSelect {
            options: choices(),
            min_items,
            max_items,
        }
    }

    fn one(kind: FieldKind, value: Value) -> Result<Value, FieldErrors> {
        validate(&[field("f", false, kind)], &json!({"f": value}))
    }

    fn message(kind: FieldKind, value: Value) -> String {
        one(kind, value).unwrap_err()["f"].clone()
    }

    #[test]
    fn accepts_valid_content_and_drops_unknown_fields() {
        let fields = [
            field("t", true, text(None, Some(1), Some(5), None)),
            field("n", false, number(true, Some(0.0), Some(10.0))),
            field("b", false, FieldKind::Boolean),
            field("s", false, FieldKind::Select { options: choices() }),
            field("m", false, multi(Some(1), Some(2))),
        ];
        let content = json!({"t": "hi", "n": 3, "b": false, "s": "a", "m": ["a", "b"], "extra": 1});
        let out = validate(&fields, &content).unwrap();
        assert_eq!(
            out,
            json!({"t": "hi", "n": 3, "b": false, "s": "a", "m": ["a", "b"]})
        );
    }

    #[test]
    fn reports_each_rule() {
        let required = field("f", true, text(None, None, None, None));
        for content in [json!({}), json!({"f": ""})] {
            assert_eq!(
                validate(std::slice::from_ref(&required), &content).unwrap_err()["f"],
                "This field is required."
            );
        }
        let cases: Vec<(FieldKind, Value, &str)> = vec![
            (
                text(None, Some(3), None, None),
                json!("ab"),
                "Use at least 3 characters.",
            ),
            (
                text(None, None, Some(2), None),
                json!("abc"),
                "Use at most 2 characters.",
            ),
            (number(false, None, None), json!("x"), "Use a number."),
            (number(true, None, None), json!(1.5), "Use a whole number."),
            (number(false, Some(2.0), None), json!(1), "Use 2 or more."),
            (number(false, None, Some(2.5)), json!(3), "Use 2.5 or less."),
            (FieldKind::Boolean, json!("yes"), "Use yes or no."),
            (
                text(Some("email"), None, None, None),
                json!("a@b"),
                "Use an email address.",
            ),
            (
                text(Some("uri"), None, None, None),
                json!("x.y"),
                "Use a full web address.",
            ),
            (
                text(Some("date"), None, None, None),
                json!("20-10-2026"),
                "Use a date.",
            ),
            (
                text(Some("date-time"), None, None, None),
                json!("2026-10-20T09:30"),
                "Use a date and time.",
            ),
            (
                text(None, None, None, Some("^[a-z]+$")),
                json!("ab1"),
                "Use the format the agent asked for.",
            ),
            (
                FieldKind::Select { options: choices() },
                json!("z"),
                "Pick one of the options.",
            ),
            (multi(Some(2), None), json!(["a"]), "Pick at least 2."),
            (multi(None, Some(1)), json!(["a", "b"]), "Pick at most 1."),
            (multi(None, None), json!(["z"]), "Pick one of the options."),
        ];
        for (kind, value, expected) in cases {
            assert_eq!(message(kind, value.clone()), expected, "{value}");
        }
    }

    #[test]
    fn counts_characters_not_bytes() {
        assert!(one(text(None, Some(2), Some(2), None), json!("éé")).is_ok());
    }

    #[test]
    fn checks_formats() {
        let formats: [(&str, &[&str], &[&str]); 4] = [
            ("email", &["a@b.co"], &["a@b", "@b.co", "a@@b.co"]),
            ("uri", &["https://x.y"], &["x.y"]),
            ("date", &["2026-10-20"], &["2026-13-01", "20-10-2026"]),
            (
                "date-time",
                &["2026-10-20T09:30:00+07:00", "2026-10-20T02:30:00Z"],
                &["2026-10-20T09:30"],
            ),
        ];
        for (format, good, bad) in formats {
            let kind = || text(Some(format), None, None, None);
            for value in good {
                assert!(one(kind(), json!(value)).is_ok(), "{format} {value}");
            }
            for value in bad {
                assert!(one(kind(), json!(value)).is_err(), "{format} {value}");
            }
        }
    }

    #[test]
    fn treats_unknown_formats_as_annotations() {
        assert!(one(text(Some("phone"), None, None, None), json!("anything")).is_ok());
    }

    #[test]
    fn checks_pattern_with_bounded_time() {
        let pattern = |p: &str, v: &str| one(text(None, None, None, Some(p)), json!(v));
        assert!(pattern("^[a-z]+$", "abc").is_ok());
        assert!(pattern("^[a-z]+$", "ab1").is_err());
        let start = Instant::now();
        let _ = pattern("(a+)+$", &("a".repeat(50_000) + "!"));
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(pattern("^(?=a)a$", "zzz").is_ok());
        assert!(pattern(&"a".repeat(2_000), "zzz").is_ok());
    }

    #[test]
    fn refuses_a_form_with_an_unsupported_field() {
        let fields = [field(
            "u",
            false,
            FieldKind::Unsupported {
                raw_type: "object".into(),
            },
        )];
        let errors = validate(&fields, &json!({})).unwrap_err();
        assert_eq!(errors["u"], "Zorvo cannot show this field.");
    }

    #[test]
    fn never_echoes_the_value() {
        let secret = "s3cr3t-value";
        let kinds = [
            text(None, Some(99), None, None),
            text(None, None, Some(2), None),
            text(Some("email"), None, None, None),
            text(Some("uri"), None, None, None),
            text(Some("date"), None, None, None),
            text(Some("date-time"), None, None, None),
            text(None, None, None, Some("^[0-9]+$")),
            number(false, None, None),
            FieldKind::Boolean,
            FieldKind::Select { options: choices() },
            multi(None, None),
        ];
        let mut failures = 0;
        for kind in kinds {
            for value in [json!(secret), json!([secret])] {
                if let Err(errors) = one(kind.clone(), value) {
                    failures += 1;
                    assert!(!errors["f"].contains(secret), "{kind:?}");
                }
            }
        }
        assert!(failures >= 10, "too few failing cases");
    }
}
