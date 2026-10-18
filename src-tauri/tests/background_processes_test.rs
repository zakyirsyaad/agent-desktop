use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use zorvo_lib::background_processes::{
    display_command, parse_etime, parse_lsof_ports, parse_ps, scan, select_tasks, stop, terminate,
    ProcessRow, TaskProcess,
};

fn row(pid: u32, ppid: u32, command: &str) -> ProcessRow {
    ProcessRow {
        pid,
        ppid,
        elapsed_secs: 60,
        command: command.to_string(),
    }
}

/// An agent (10) running a dev server through a shell (11), an MCP server
/// (20) and an interactive shell (30) that itself runs a shell (31); 40 is
/// outside every session.
fn tree() -> Vec<ProcessRow> {
    vec![
        row(1, 0, "/sbin/launchd"),
        // The agent has run longer than anything it started.
        ProcessRow {
            elapsed_secs: 600,
            ..row(10, 1, "/usr/bin/agent --acp")
        },
        row(11, 10, "/bin/zsh -c npm run dev"),
        row(12, 11, "npm run dev"),
        row(13, 12, "node vite"),
        row(20, 10, "node mcp-server.js"),
        row(30, 10, "-zsh"),
        row(31, 30, "bash -c ls"),
        row(40, 1, "/bin/zsh -c make"),
    ]
}

#[test]
fn parses_elapsed_times() {
    assert_eq!(parse_etime("05:07"), Some(307));
    assert_eq!(parse_etime("1:02:03"), Some(3723));
    assert_eq!(parse_etime("2-01:00:00"), Some(176_400));
    assert_eq!(parse_etime("x"), None);
}

#[test]
fn parses_ps_rows() {
    let rows = parse_ps(
        "  10     1   01:00 /usr/bin/agent --acp\n  11    10   00:30 /bin/zsh -c npm run dev\n",
    );
    assert_eq!(
        rows,
        vec![
            ProcessRow {
                pid: 10,
                ppid: 1,
                elapsed_secs: 60,
                command: "/usr/bin/agent --acp".to_string(),
            },
            ProcessRow {
                pid: 11,
                ppid: 10,
                elapsed_secs: 30,
                command: "/bin/zsh -c npm run dev".to_string(),
            },
        ]
    );
}

#[test]
fn selects_the_outermost_shells_under_each_root() {
    let tasks = select_tasks(&tree(), &[("s1".to_string(), 10)]);

    let pids: Vec<u32> = tasks.iter().map(|t| t.pid).collect();
    assert_eq!(pids, vec![11, 30]);
    assert!(tasks.iter().all(|t| t.session_id == "s1"));
    let dev = &tasks[0];
    assert_eq!(dev.subtree, vec![13, 12, 11]);
    assert_eq!(dev.command, "/bin/zsh -c npm run dev");
    assert_eq!(dev.elapsed_secs, 60);
}

#[test]
fn looks_through_a_shell_that_launched_the_agent_itself() {
    // An adapter that starts its CLI with `sh -c`: the shell is as old as the
    // agent, and only what the CLI runs later is a task.
    let rows = vec![
        ProcessRow {
            elapsed_secs: 600,
            ..row(10, 1, "node adapter.js --acp")
        },
        ProcessRow {
            elapsed_secs: 600,
            ..row(11, 10, "/bin/sh -c claude --print")
        },
        ProcessRow {
            elapsed_secs: 599,
            ..row(12, 11, "node claude --print")
        },
        ProcessRow {
            elapsed_secs: 30,
            ..row(13, 12, "/bin/zsh -c npm run dev")
        },
    ];

    let tasks = select_tasks(&rows, &[("s1".to_string(), 10)]);

    let pids: Vec<u32> = tasks.iter().map(|t| t.pid).collect();
    assert_eq!(pids, vec![13]);
}

#[test]
fn looks_through_a_launcher_shell_deeper_down_and_a_little_later() {
    // adapter -> npm exec -> sh -c cli: npm takes a moment to start the shell.
    let rows = vec![
        ProcessRow {
            elapsed_secs: 600,
            ..row(10, 1, "node adapter.js --acp")
        },
        ProcessRow {
            elapsed_secs: 599,
            ..row(11, 10, "npm exec @acme/agent-cli")
        },
        ProcessRow {
            elapsed_secs: 598,
            ..row(12, 11, "sh -c agent-cli --acp")
        },
        ProcessRow {
            elapsed_secs: 598,
            ..row(13, 12, "node agent-cli --acp")
        },
        ProcessRow {
            elapsed_secs: 30,
            ..row(14, 13, "/bin/zsh -c npm run dev")
        },
    ];

    let tasks = select_tasks(&rows, &[("s1".to_string(), 10)]);

    let pids: Vec<u32> = tasks.iter().map(|t| t.pid).collect();
    assert_eq!(pids, vec![14]);
}

#[test]
fn never_lists_a_process_outside_every_root() {
    let tasks = select_tasks(&tree(), &[("s1".to_string(), 10)]);
    assert!(tasks.iter().all(|t| t.pid != 40));

    assert!(select_tasks(&tree(), &[]).is_empty());
}

#[test]
fn a_root_shared_by_two_sessions_lists_each_task_once() {
    let roots = [("s1".to_string(), 10), ("s2".to_string(), 10)];

    let tasks = select_tasks(&tree(), &roots);

    let pids: Vec<u32> = tasks.iter().map(|t| t.pid).collect();
    assert_eq!(pids, vec![11, 30]);
    assert!(tasks.iter().all(|t| t.session_id == "s1"));
}

#[test]
fn shows_the_command_a_shell_was_asked_to_run() {
    let claude_code = "/bin/zsh -c -l source /Users/x/.claude/shell-snapshots/snap.sh && eval 'npm run dev' \\< /dev/null && pwd -P >| /tmp/cwd";
    assert_eq!(display_command(claude_code), "npm run dev");
    assert_eq!(display_command("bash -c \"pnpm test\""), "pnpm test");
}

#[test]
fn reads_the_script_after_combined_shell_flags() {
    assert_eq!(
        display_command("/bin/bash -lc \"npm run dev\""),
        "npm run dev"
    );
    assert_eq!(display_command("zsh -ic 'pnpm test'"), "pnpm test");
    assert_eq!(display_command("bash -lic make"), "make");
}

#[test]
fn shows_each_line_of_a_multi_line_command_on_one_line() {
    let raw = "bash -c cd web\\012pnpm dev";
    assert_eq!(display_command(raw), "cd web pnpm dev");
}

#[test]
fn undoes_quote_escaping_in_an_eval_argument() {
    let raw = "/bin/zsh -c source /tmp/snap.sh && eval 'echo '\"'\"'hi'\"'\"'' \\< /dev/null";
    assert_eq!(display_command(raw), "echo 'hi'");
}

#[test]
fn caps_a_long_command_at_300_characters() {
    let raw = format!("bash -c {}", "a".repeat(500));

    let shown = display_command(&raw);

    assert_eq!(shown.chars().count(), 300);
    assert!(shown.ends_with('…'));
}

#[test]
fn parses_listening_ports_per_pid() {
    let ports = parse_lsof_ports("p11\nn*:5173\np13\nn127.0.0.1:3000\n");

    assert_eq!(ports, HashMap::from([(11, vec![5173]), (13, vec![3000])]));
}

#[test]
fn refuses_to_stop_a_process_that_is_not_a_task() {
    let roots = [("s1".to_string(), std::process::id())];

    let error = stop(&roots, 1).expect_err("launchd is not a task");

    assert!(error.contains("is no longer running"), "{error}");
}

/// Answers whether `pid` is a process this user can signal.
fn is_alive(pid: u32) -> bool {
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Polls `condition` every 50 ms until it holds or `limit` passes.
fn eventually(limit: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// A spawned process tree that is killed, descendants first, however the
/// test ends.
struct TreeGuard(Child);

impl Drop for TreeGuard {
    fn drop(&mut self) {
        let root = self.0.id();
        if let Ok(output) = Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,etime=,command="])
            .output()
        {
            let rows = parse_ps(&String::from_utf8_lossy(&output.stdout));
            let mut stack = vec![root];
            let mut descendants = Vec::new();
            while let Some(parent) = stack.pop() {
                for child in rows.iter().filter(|r| r.ppid == parent) {
                    descendants.push(child.pid);
                    stack.push(child.pid);
                }
            }
            for pid in descendants.iter().rev() {
                let _ = Command::new("/bin/kill")
                    .args(["-KILL", &pid.to_string()])
                    .stderr(Stdio::null())
                    .status();
            }
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(target_os = "macos")]
#[test]
fn stops_a_running_task_and_everything_it_started() {
    let root = Command::new("/bin/sh")
        .args(["-c", "sleep 4; /bin/sh -c 'sleep 30; :' & wait"])
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the root");
    let guard = TreeGuard(root);
    let roots = [("s1".to_string(), guard.0.id())];

    let mut task = None;
    let found = eventually(Duration::from_secs(5), || {
        task = scan(&roots, false).expect("scan").into_iter().next();
        task.is_some()
    });
    assert!(found, "the inner shell never showed up as a task");
    let task = task.expect("task");
    assert_eq!(task.session_id, "s1");
    let sleeper = eventually(Duration::from_secs(5), || {
        let output = Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,etime=,command="])
            .output()
            .expect("run ps");
        parse_ps(&String::from_utf8_lossy(&output.stdout))
            .iter()
            .any(|r| r.ppid == task.pid && r.command.starts_with("sleep"))
    });
    assert!(sleeper, "the task never started sleep");
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,etime=,command="])
        .output()
        .expect("run ps");
    let sleep_pid = parse_ps(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .find(|r| r.ppid == task.pid && r.command.starts_with("sleep"))
        .expect("sleep")
        .pid;

    stop(&roots, task.pid).expect("stop the task");

    assert!(
        eventually(Duration::from_secs(3), || !is_alive(task.pid)
            && !is_alive(sleep_pid)),
        "the task or its sleep is still running"
    );
}

/// Every process, from `ps`.
fn ps_rows() -> Vec<ProcessRow> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,etime=,command="])
        .output()
        .expect("run ps");
    parse_ps(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "macos")]
#[test]
fn kills_a_task_that_ignores_term_even_when_part_of_it_already_exited() {
    // A process that has exited and been reaped: signalling it fails.
    let mut gone = Command::new("/usr/bin/true").spawn().expect("spawn true");
    gone.wait().expect("reap true");
    let gone_pid = gone.id();
    // The shell and its sleep both ignore TERM, so only KILL ends them.
    let shell = Command::new("/bin/sh")
        .args(["-c", "trap '' TERM; sleep 30; :"])
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the shell");
    let mut guard = TreeGuard(shell);
    let shell_pid = guard.0.id();

    let mut rows = Vec::new();
    let started = eventually(Duration::from_secs(5), || {
        rows = ps_rows();
        rows.iter()
            .any(|r| r.ppid == shell_pid && r.command.starts_with("sleep"))
    });
    assert!(started, "the shell never started sleep");
    let sleep_pid = rows
        .iter()
        .find(|r| r.ppid == shell_pid && r.command.starts_with("sleep"))
        .expect("sleep")
        .pid;
    let task = TaskProcess {
        pid: shell_pid,
        session_id: "s1".to_string(),
        command: "/bin/sh -c trap '' TERM; sleep 30; :".to_string(),
        elapsed_secs: 0,
        subtree: vec![gone_pid, sleep_pid, shell_pid],
    };

    terminate(&task, &rows).expect("stop the task");

    assert!(
        eventually(Duration::from_secs(5), || {
            matches!(guard.0.try_wait(), Ok(Some(_))) && !is_alive(sleep_pid)
        }),
        "the shell or its sleep is still running"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn reports_the_port_a_task_listens_on() {
    let root = Command::new("/bin/sh")
        .args([
            "-c",
            "sleep 4; /bin/sh -c 'python3 -m http.server 0 --bind 127.0.0.1; :' & wait",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn the root");
    let guard = TreeGuard(root);
    let roots = [("s1".to_string(), guard.0.id())];

    let listening = eventually(Duration::from_secs(10), || {
        scan(&roots, true)
            .expect("scan")
            .iter()
            .any(|task| !task.ports.is_empty())
    });
    let without_ports = scan(&roots, false).expect("scan");

    assert!(listening, "the server's port never showed up");
    assert!(!without_ports.is_empty());
    assert!(without_ports.iter().all(|task| task.ports.is_empty()));
}
