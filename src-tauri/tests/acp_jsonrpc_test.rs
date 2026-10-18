use serde_json::json;
use zorvo_lib::acp::jsonrpc::{
    error_response, notification, parse_incoming, request, response, Incoming,
};

#[test]
fn builds_newline_free_request_lines() {
    let line = request(7, "session/new", json!({ "cwd": "/w", "mcpServers": [] }));

    assert!(!line.contains('\n'));
    let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(parsed["jsonrpc"], "2.0");
    assert_eq!(parsed["id"], 7);
    assert_eq!(parsed["method"], "session/new");
    assert_eq!(parsed["params"]["cwd"], "/w");
}

#[test]
fn builds_notifications_without_an_id() {
    let parsed: serde_json::Value =
        serde_json::from_str(&notification("session/cancel", json!({ "sessionId": "a" }))).unwrap();

    assert!(parsed.get("id").is_none());
    assert_eq!(parsed["method"], "session/cancel");
}

#[test]
fn builds_responses_and_errors_for_agent_requests() {
    let ok: serde_json::Value =
        serde_json::from_str(&response(&json!(3), json!({ "x": 1 }))).unwrap();
    assert_eq!(ok["id"], 3);
    assert_eq!(ok["result"]["x"], 1);

    let err: serde_json::Value =
        serde_json::from_str(&error_response(&json!("r-9"), -32601, "Method not found")).unwrap();
    assert_eq!(err["id"], "r-9");
    assert_eq!(err["error"]["code"], -32601);
}

#[test]
fn classifies_a_response_to_our_request() {
    let incoming =
        parse_incoming(r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s"}}"#).unwrap();

    match incoming {
        Incoming::Response { id, result } => {
            assert_eq!(id, 2);
            assert_eq!(result.unwrap()["sessionId"], "s");
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn classifies_an_error_response() {
    let incoming =
        parse_incoming(r#"{"jsonrpc":"2.0","id":5,"error":{"code":-32603,"message":"boom"}}"#)
            .unwrap();

    match incoming {
        Incoming::Response { id, result } => {
            assert_eq!(id, 5);
            assert_eq!(result.unwrap_err()["message"], "boom");
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn classifies_requests_from_the_agent_with_any_id_type() {
    let incoming = parse_incoming(
        r#"{"jsonrpc":"2.0","id":"p-1","method":"session/request_permission","params":{"sessionId":"s"}}"#,
    )
    .unwrap();

    match incoming {
        Incoming::Request { id, method, params } => {
            assert_eq!(id, json!("p-1"));
            assert_eq!(method, "session/request_permission");
            assert_eq!(params["sessionId"], "s");
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn classifies_notifications() {
    let incoming = parse_incoming(
        r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk"}}}"#,
    )
    .unwrap();

    match incoming {
        Incoming::Notification { method, params } => {
            assert_eq!(method, "session/update");
            assert_eq!(params["update"]["sessionUpdate"], "agent_message_chunk");
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn rejects_lines_that_are_not_json_rpc_messages() {
    assert!(parse_incoming("not json").is_err());
    assert!(parse_incoming(r#"{"jsonrpc":"2.0"}"#).is_err());
    assert!(parse_incoming(r#"[1,2]"#).is_err());
    // A response must carry a numeric id: we only ever send numeric ids.
    assert!(parse_incoming(r#"{"jsonrpc":"2.0","id":"x","result":{}}"#).is_err());
}
