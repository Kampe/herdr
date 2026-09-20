use super::harness::*;

fn reply_to_deadline_start(listener: &UnixListener, agent: serde_json::Value) {
    let (mut start_stream, start_line) = accept_fake_cli_operation(listener);
    let start: serde_json::Value = serde_json::from_str(&start_line).unwrap();
    assert_eq!(start["method"], "agent.start");
    writeln!(
        start_stream,
        "{}",
        serde_json::json!({
            "id": start["id"],
            "result": {
                "type": "agent_started",
                "agent": {"terminal_id": "term_1", "name": "reviewer"},
                "argv": ["pi"]
            }
        })
    )
    .unwrap();
    start_stream.flush().unwrap();

    let (mut get_stream, get_line) = accept_fake_cli_operation(listener);
    let get: serde_json::Value = serde_json::from_str(&get_line).unwrap();
    assert_eq!(get["method"], "agent.get");
    assert_eq!(get["params"]["target"], "reviewer");
    assert_eq!(
        get["id"], "cli:agent:start:timeout",
        "fixture must exercise the real final deadline request"
    );
    writeln!(
        get_stream,
        "{}",
        serde_json::json!({"id": get["id"], "result": {"type": "agent_info", "agent": agent}})
    )
    .unwrap();
    get_stream.flush().unwrap();
}

fn agent_start_deadline_case(kind: &str, name: &str, terminal_id: &str) -> std::process::Output {
    let base = unique_test_dir();
    fs::create_dir_all(&base).unwrap();
    let socket_path = base.join("herdr.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let agent = serde_json::json!({
        "agent": kind,
        "agent_status": "working",
        "interactive_ready": true,
        "launch_pending": false,
        "name": name,
        "pane_id": "w1:p1",
        "terminal_id": terminal_id
    });
    let server = thread::spawn(move || reply_to_deadline_start(&listener, agent));
    // Only the fake server accepts zero: deterministically enter the client's
    // deadline branch without sleeps. Real server timeout validation has its
    // own CLI integration controls in agents.rs.
    let output = run_cli(
        &socket_path,
        &[
            "agent",
            "start",
            "reviewer",
            "--kind",
            "pi",
            "--pane",
            "w1:p1",
            "--timeout",
            "0",
        ],
    );
    server.join().unwrap();
    cleanup_test_base(&base);
    output
}

#[test]
fn agent_start_deadline_rejects_a_different_kind_on_the_same_named_terminal() {
    let output = agent_start_deadline_case("codex", "reviewer", "term_1");
    assert_eq!(
        output.status.code(),
        Some(1),
        "deadline accepted a different agent kind on the same named terminal"
    );
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], "agent_kind_mismatch");
    assert_eq!(error["error"]["message"], "expected pi, detected codex");
}

#[test]
fn agent_start_deadline_accepts_matching_working_agent_identity() {
    let output = agent_start_deadline_case("pi", "reviewer", "term_1");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let started: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(started["result"]["type"], "agent_started");
    assert_eq!(started["result"]["agent"]["agent"], "pi");
    assert_eq!(started["result"]["agent"]["name"], "reviewer");
    assert_eq!(started["result"]["agent"]["terminal_id"], "term_1");
}

#[test]
fn agent_start_deadline_rejects_replaced_terminal_or_name() {
    for (name, terminal_id) in [("reviewer", "term_2"), ("replacement", "term_1")] {
        let output = agent_start_deadline_case("pi", name, terminal_id);
        assert_eq!(output.status.code(), Some(1));
        let error: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["error"]["code"], "agent_name_not_found");
    }
}

#[test]
fn agent_start_accepts_durable_readiness_during_detection_gap() {
    let base = unique_test_dir();
    fs::create_dir_all(&base).unwrap();
    let socket_path = base.join("herdr.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();

    let server = thread::spawn(move || {
        let (mut start_stream, start_line) = accept_fake_cli_operation(&listener);
        let start: serde_json::Value = serde_json::from_str(&start_line).unwrap();
        assert_eq!(start["method"], "agent.start");
        writeln!(
            start_stream,
            "{}",
            serde_json::json!({
                "id": start["id"],
                "result": {
                    "type": "agent_started",
                    "agent": {
                        "pane_id": "w1:p1",
                        "terminal_id": "term_1",
                        "name": "reviewer"
                    },
                    "argv": ["opencode"]
                }
            })
        )
        .unwrap();
        start_stream.flush().unwrap();

        let (mut get_stream, get_line) = accept_fake_cli_operation(&listener);
        let get: serde_json::Value = serde_json::from_str(&get_line).unwrap();
        assert_eq!(get["method"], "agent.get");
        assert_eq!(get["params"]["target"], "reviewer");
        writeln!(
            get_stream,
            "{}",
            serde_json::json!({
                "id": get["id"],
                "result": {
                    "type": "agent_info",
                    "agent": {
                        "agent": null,
                        "agent_status": "unknown",
                        "interactive_ready": true,
                        "launch_pending": false,
                        "name": "reviewer",
                        "pane_id": "w1:p1",
                        "terminal_id": "term_1"
                    }
                }
            })
        )
        .unwrap();
        get_stream.flush().unwrap();
    });

    let started = run_cli(
        &socket_path,
        &[
            "agent", "start", "reviewer", "--kind", "opencode", "--pane", "w1:p1",
        ],
    );
    assert!(
        started.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&started.stderr)
    );
    let started: serde_json::Value = serde_json::from_slice(&started.stdout).unwrap();
    assert_eq!(started["result"]["type"], "agent_started");
    assert_eq!(started["result"]["agent"]["name"], "reviewer");
    assert!(started["result"]["agent"]["interactive_ready"]
        .as_bool()
        .unwrap());

    server.join().unwrap();
    cleanup_test_base(&base);
}

#[test]
fn prompt_wait_is_sent_as_one_agent_request() {
    let base = unique_test_dir();
    fs::create_dir_all(&base).unwrap();
    let socket_path = base.join("herdr.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();

    let server = thread::spawn(move || {
        let (mut prompt_stream, prompt_line) = accept_fake_cli_operation(&listener);
        let prompt: serde_json::Value = serde_json::from_str(&prompt_line).unwrap();
        assert_eq!(prompt["method"], "agent.prompt");
        assert_eq!(prompt["params"]["target"], "w1:p1");
        assert_eq!(
            prompt["params"]["wait"]["until"],
            serde_json::json!(["idle"])
        );
        assert!(prompt["params"]["wait"].get("timeout_ms").is_none());
        writeln!(
            prompt_stream,
            "{}",
            serde_json::json!({
                "id": prompt["id"],
                "result": {
                    "type": "agent_prompted",
                    "agent": {
                        "pane_id": "w1:p1",
                        "terminal_id": "term_1",
                        "name": "reviewer",
                        "agent": "pi",
                        "agent_status": "idle",
                        "workspace_id": "w1",
                        "tab_id": "w1:t1",
                        "focused": true,
                        "revision": 0
                    }
                }
            })
        )
        .unwrap();
        prompt_stream.flush().unwrap();
    });

    let prompted = run_cli(
        &socket_path,
        &[
            "agent",
            "prompt",
            "w1:p1",
            "review this",
            "--wait",
            "--until",
            "idle",
        ],
    );
    assert!(
        prompted.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&prompted.stderr)
    );
    let prompted: serde_json::Value = serde_json::from_slice(&prompted.stdout).unwrap();
    assert_eq!(prompted["result"]["agent"]["name"], "reviewer");

    server.join().unwrap();
    cleanup_test_base(&base);
}
