//! ACP elicitation: an agent asks the user for input mid-turn.

mod url_check;

pub use url_check::{check_url, UrlCheck, UrlWarning};

use serde::Serialize;
use serde_json::{json, Map, Value};

/// A parsed `elicitation/create` request.
#[derive(Debug, Clone, PartialEq)]
pub enum Elicitation {
    Form {
        message: String,
        fields: Vec<Field>,
    },
    Url {
        message: String,
        elicitation_id: String,
        url: String,
        check: UrlCheck,
    },
}

/// One input of a form request, in the order the agent listed it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub required: bool,
    pub kind: FieldKind,
    pub default: Option<Value>,
}

/// What a field asks for. `pattern` stays in the backend for validation.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FieldKind {
    Text {
        format: Option<String>,
        min_length: Option<u64>,
        max_length: Option<u64>,
        #[serde(skip)]
        pattern: Option<String>,
    },
    Number {
        integer: bool,
        minimum: Option<f64>,
        maximum: Option<f64>,
    },
    Boolean,
    Select {
        options: Vec<Choice>,
    },
    MultiSelect {
        options: Vec<Choice>,
        min_items: Option<u64>,
        max_items: Option<u64>,
    },
    /// A schema Zorvo cannot show; the form cannot be submitted.
    Unsupported {
        raw_type: String,
    },
}

/// One option of a select field.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Choice {
    pub value: String,
    pub title: String,
    pub description: Option<String>,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

/// Options from a plain `enum` list, where each title is its value. `None`
/// when any entry is not a string.
fn enum_choices(list: &[Value]) -> Option<Vec<Choice>> {
    list.iter()
        .map(|entry| {
            let value = entry.as_str()?;
            Some(Choice {
                value: value.to_string(),
                title: value.to_string(),
                description: None,
            })
        })
        .collect()
}

/// Options from `oneOf` or `anyOf` entries with `const` and `title`. `None`
/// when any entry has no string `const`.
fn titled_choices(list: &[Value]) -> Option<Vec<Choice>> {
    list.iter()
        .map(|entry| {
            let value = text(entry, "const")?;
            Some(Choice {
                title: text(entry, "title").unwrap_or_else(|| value.clone()),
                description: text(entry, "description"),
                value,
            })
        })
        .collect()
}

/// Whether a schema node lists options at all, usable or not.
fn lists_choices(node: &Value) -> bool {
    ["enum", "oneOf", "anyOf"]
        .iter()
        .any(|key| node.get(*key).is_some_and(Value::is_array))
}

/// Reads the options a schema node lists. `None` when an entry is unusable or
/// no option is left, so a field never shows fewer options than offered.
fn choices(node: &Value) -> Option<Vec<Choice>> {
    let options = if let Some(list) = node.get("enum").and_then(Value::as_array) {
        enum_choices(list)?
    } else {
        let list = ["oneOf", "anyOf"]
            .iter()
            .find_map(|key| node.get(*key)?.as_array())?;
        titled_choices(list)?
    };
    (!options.is_empty()).then_some(options)
}

fn unsupported(raw_type: &str) -> FieldKind {
    FieldKind::Unsupported {
        raw_type: raw_type.to_string(),
    }
}

fn parse_kind(schema: &Value) -> FieldKind {
    let raw_type = text(schema, "type");
    match raw_type.as_deref() {
        Some("string") if lists_choices(schema) => match choices(schema) {
            Some(options) => FieldKind::Select { options },
            None => unsupported("string"),
        },
        Some("string") => FieldKind::Text {
            format: text(schema, "format"),
            min_length: schema.get("minLength").and_then(Value::as_u64),
            max_length: schema.get("maxLength").and_then(Value::as_u64),
            pattern: text(schema, "pattern"),
        },
        Some(kind @ ("number" | "integer")) => FieldKind::Number {
            integer: kind == "integer",
            minimum: schema.get("minimum").and_then(Value::as_f64),
            maximum: schema.get("maximum").and_then(Value::as_f64),
        },
        Some("boolean") => FieldKind::Boolean,
        Some("array") => match schema.get("items").and_then(choices) {
            Some(options) => FieldKind::MultiSelect {
                options,
                min_items: schema.get("minItems").and_then(Value::as_u64),
                max_items: schema.get("maxItems").and_then(Value::as_u64),
            },
            None => unsupported("array"),
        },
        other => FieldKind::Unsupported {
            raw_type: other.unwrap_or("unknown").to_string(),
        },
    }
}

/// Keeps the agent's default only when it fits the field.
fn fitting_default(kind: &FieldKind, default: Option<&Value>) -> Option<Value> {
    let value = default?;
    let fits = match kind {
        FieldKind::Text { .. } => value.is_string(),
        FieldKind::Number { .. } => value.is_number(),
        FieldKind::Boolean => value.is_boolean(),
        FieldKind::Select { options } => value
            .as_str()
            .is_some_and(|v| options.iter().any(|o| o.value == v)),
        FieldKind::MultiSelect { options, .. } => value.as_array().is_some_and(|items| {
            items.iter().all(|item| {
                item.as_str()
                    .is_some_and(|v| options.iter().any(|o| o.value == v))
            })
        }),
        FieldKind::Unsupported { .. } => false,
    };
    fits.then(|| value.clone())
}

fn parse_field(name: &str, schema: &Value, required: bool) -> Field {
    let kind = parse_kind(schema);
    Field {
        name: name.to_string(),
        title: text(schema, "title"),
        description: text(schema, "description"),
        required,
        default: fitting_default(&kind, schema.get("default")),
        kind,
    }
}

fn parse_form(params: &Value) -> Result<Elicitation, String> {
    let schema = params
        .get("requestedSchema")
        .filter(|schema| schema.is_object())
        .ok_or("The form has no schema.")?;
    let empty = Map::new();
    let properties = match schema.get("properties") {
        None => &empty,
        Some(Value::Object(map)) => map,
        Some(_) => return Err("The form's properties are not an object.".to_string()),
    };
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let fields = properties
        .iter()
        .map(|(name, field)| parse_field(name, field, required.contains(&name.as_str())))
        .collect();
    Ok(Elicitation::Form {
        message: text(params, "message").unwrap_or_default(),
        fields,
    })
}

fn parse_url(params: &Value) -> Result<Elicitation, String> {
    let elicitation_id =
        text(params, "elicitationId").ok_or("The request has no elicitationId.")?;
    let url = text(params, "url").ok_or("The request has no url.")?;
    let check = check_url(&url);
    Ok(Elicitation::Url {
        message: text(params, "message").unwrap_or_default(),
        // Keep the link that was checked, not the agent's raw text.
        url: check.url.clone().unwrap_or(url),
        check,
        elicitation_id,
    })
}

/// Reads the params of an `elicitation/create` request.
pub fn parse_request(params: &Value) -> Result<Elicitation, String> {
    match params.get("mode").and_then(Value::as_str) {
        Some("form") => parse_form(params),
        Some("url") => parse_url(params),
        Some(_) => Err("The request asks for a mode Zorvo does not know.".to_string()),
        None => Err("The request has no mode.".to_string()),
    }
}

impl Elicitation {
    /// The payload the UI shows. It leaves out the validation pattern and the
    /// elicitation id, which stay in the backend.
    pub fn view(&self) -> Value {
        match self {
            Elicitation::Form { message, fields } => {
                json!({"mode": "form", "message": message, "fields": fields})
            }
            Elicitation::Url {
                message,
                url,
                check,
                ..
            } => json!({
                "mode": "url",
                "message": message,
                "url": url,
                "host": check.host,
                "warnings": check.warnings,
                "blocked": check.blocked,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn form(schema: Value) -> Vec<Field> {
        match parse_request(&json!({"mode": "form", "message": "m", "requestedSchema": schema}))
            .unwrap()
        {
            Elicitation::Form { fields, .. } => fields,
            other => panic!("not a form: {other:?}"),
        }
    }

    #[test]
    fn parses_a_form_with_every_field_kind() {
        let fields = form(json!({
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": {"type": "string", "minLength": 2, "maxLength": 50,
                         "format": "email", "default": "a@b.co"},
                "age": {"type": "integer", "minimum": 0, "maximum": 120},
                "ratio": {"type": "number"},
                "agree": {"type": "boolean", "default": true},
                "color": {"type": "string", "enum": ["Red", "Green"]},
                "tone": {"type": "string", "oneOf": [
                    {"const": "#f00", "title": "Red", "description": "Loud"}]},
                "tags": {"type": "array", "minItems": 1, "maxItems": 2,
                         "items": {"type": "string", "enum": ["a", "b"]}},
                "labels": {"type": "array", "items": {"anyOf": [
                    {"const": "x", "title": "Ex"}]}}
            }
        }));
        let names: Vec<_> = fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            ["name", "age", "ratio", "agree", "color", "tone", "tags", "labels"]
        );
        assert!(fields[0].required);
        assert!(!fields[1].required);
        assert_eq!(fields[0].default, Some(json!("a@b.co")));
        assert_eq!(
            fields[0].kind,
            FieldKind::Text {
                format: Some("email".into()),
                min_length: Some(2),
                max_length: Some(50),
                pattern: None
            }
        );
        assert_eq!(
            fields[1].kind,
            FieldKind::Number {
                integer: true,
                minimum: Some(0.0),
                maximum: Some(120.0)
            }
        );
        assert!(matches!(
            fields[2].kind,
            FieldKind::Number { integer: false, .. }
        ));
        assert_eq!(fields[3].kind, FieldKind::Boolean);
        assert_eq!(fields[3].default, Some(json!(true)));
        let FieldKind::Select { options } = &fields[4].kind else {
            panic!("color")
        };
        assert!(options.iter().all(|o| o.title == o.value));
        let FieldKind::Select { options } = &fields[5].kind else {
            panic!("tone")
        };
        assert_eq!(options[0].value, "#f00");
        assert_eq!(options[0].title, "Red");
        assert_eq!(options[0].description.as_deref(), Some("Loud"));
        let FieldKind::MultiSelect {
            options,
            min_items,
            max_items,
        } = &fields[6].kind
        else {
            panic!("tags")
        };
        assert_eq!(options.len(), 2);
        assert_eq!((*min_items, *max_items), (Some(1), Some(2)));
        let FieldKind::MultiSelect { options, .. } = &fields[7].kind else {
            panic!("labels")
        };
        assert_eq!(options[0].title, "Ex");
    }

    #[test]
    fn keeps_a_default_only_when_it_fits() {
        let fields = form(json!({"properties": {
            "s": {"type": "string", "default": 5},
            "c": {"type": "string", "enum": ["a"], "default": "z"},
            "ok": {"type": "string", "enum": ["a"], "default": "a"}
        }}));
        assert_eq!(fields[0].default, None);
        assert_eq!(fields[1].default, None);
        assert_eq!(fields[2].default, Some(json!("a")));
    }

    #[test]
    fn reads_a_missing_type_as_an_object_and_missing_properties_as_empty() {
        assert_eq!(
            form(json!({"properties": {"a": {"type": "boolean"}}})).len(),
            1
        );
        assert!(form(json!({"type": "object"})).is_empty());
    }

    #[test]
    fn marks_unknown_types_unsupported() {
        let fields = form(json!({"properties": {
            "a": {"type": "_x"},
            "b": {"type": "array", "items": {"type": "number"}}
        }}));
        assert_eq!(
            fields[0].kind,
            FieldKind::Unsupported {
                raw_type: "_x".into()
            }
        );
        assert_eq!(
            fields[1].kind,
            FieldKind::Unsupported {
                raw_type: "array".into()
            }
        );
    }

    #[test]
    fn refuses_unknown_modes_and_malformed_requests() {
        for params in [
            json!({"mode": "voice", "message": "m"}),
            json!({"message": "m"}),
            json!({"mode": "form", "message": "m", "requestedSchema": "x"}),
            json!({"mode": "form", "message": "m",
                   "requestedSchema": {"type": "object", "properties": null}}),
            json!({"mode": "url", "message": "m", "url": "https://a.dev"}),
        ] {
            assert!(parse_request(&params).is_err(), "{params}");
        }
    }

    #[test]
    fn parses_a_url_request() {
        let parsed = parse_request(&json!({
            "mode": "url", "elicitationId": "gh-1",
            "url": "https://agent.example.com/connect", "message": "Authorize"
        }))
        .unwrap();
        let Elicitation::Url {
            message,
            elicitation_id,
            url,
            check,
        } = parsed
        else {
            panic!("not a url request")
        };
        assert_eq!(message, "Authorize");
        assert_eq!(elicitation_id, "gh-1");
        assert_eq!(url, "https://agent.example.com/connect");
        assert_eq!(check.host, "agent.example.com");
    }

    #[test]
    fn view_carries_no_pattern_and_no_elicitation_id() {
        let form_view = parse_request(&json!({
            "mode": "form", "message": "Hi",
            "requestedSchema": {"properties": {
                "a": {"type": "string", "pattern": "^x$"},
                "b": {"type": "array", "items": {"enum": ["q"]}},
                "c": {"type": "_x"}
            }}
        }))
        .unwrap()
        .view();
        assert_eq!(form_view["mode"], "form");
        assert_eq!(form_view["message"], "Hi");
        let kinds: Vec<_> = form_view["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["kind"]["type"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(kinds, ["text", "multiSelect", "unsupported"]);
        assert!(!form_view.to_string().contains("pattern"));

        let url_view = parse_request(&json!({
            "mode": "url", "elicitationId": "id-9", "message": "Go",
            "url": "https://xn--pple-43d.com/"
        }))
        .unwrap()
        .view();
        assert_eq!(
            url_view,
            json!({"mode": "url", "message": "Go", "url": "https://xn--pple-43d.com/",
                   "host": "xn--pple-43d.com", "warnings": ["punycode"], "blocked": null})
        );
    }

    #[test]
    fn marks_unusable_options_unsupported() {
        let fields = form(json!({"properties": {
            "a": {"type": "string", "enum": [1, 2]},
            "b": {"type": "string", "enum": []},
            "c": {"type": "string", "oneOf": [
                {"const": "x", "title": "X"}, {"title": "no const"}]},
            "d": {"type": "array", "items": {"enum": [1]}},
            "e": {"type": "string", "enum": ["a", 2]}
        }}));
        let raw: Vec<_> = fields
            .iter()
            .map(|f| match &f.kind {
                FieldKind::Unsupported { raw_type } => raw_type.as_str(),
                other => panic!("not unsupported: {other:?}"),
            })
            .collect();
        assert_eq!(raw, ["string", "string", "string", "array", "string"]);
    }

    #[test]
    fn keeps_the_checked_url_not_the_raw_one() {
        for raw in [
            " https://agent.example.com/a",
            "https://agent.example.com\\a",
        ] {
            let params = json!({"mode": "url", "elicitationId": "i", "message": "m", "url": raw});
            let Elicitation::Url { url, .. } = parse_request(&params).unwrap() else {
                panic!("not a url request")
            };
            assert_eq!(url, "https://agent.example.com/a", "{raw:?}");
            assert_eq!(parse_request(&params).unwrap().view()["url"], url);
        }
        let bad = parse_request(&json!({"mode": "url", "elicitationId": "i",
                                        "message": "m", "url": "not a url"}))
        .unwrap();
        assert_eq!(bad.view()["url"], "not a url");
        assert!(bad.view()["blocked"].is_string());
    }
}
