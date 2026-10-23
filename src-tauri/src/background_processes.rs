//! The commands agents started that are still running (dev servers, watchers,
//! long builds): finding them, and stopping one with everything it started.
//!
//! A task is a shell under an agent's process whose path up to the agent has
//! no other task, or a command that replaced its shell and leads its own
//! process group. A shell that started together with the agent launched the
//! agent's own program, so it is looked through rather than listed.
//! Stopping only ever signals a task a fresh scan reports at that moment, so
//! a pid the UI held on to cannot reach a process that reused it.

use std::collections::{HashMap, HashSet};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::acp::manager::AcpManager;

/// The base names of the programs that count as shells.
const SHELLS: [&str; 5] = ["sh", "bash", "zsh", "dash", "fish"];
/// The longest command shown, in characters, the ellipsis included.
const MAX_COMMAND_CHARS: usize = 300;
/// A shell under the agent that started within this many seconds of the
/// agent itself launched the agent's own program (`sh -c claude …`, maybe
/// through `npm exec`): it is looked through, not listed. Nothing the agent is
/// asked to run starts that soon, as it waits for a prompt and the model first.
const LAUNCHER_START_SECS: u64 = 3;
/// How long a task has to end after `TERM` before it is sent `KILL`.
const KILL_GRACE: Duration = Duration::from_secs(2);
/// Where a shell snapshot's wrapper continues after the command it runs.
const WRAPPER_TAILS: [&str; 2] = [" \\< /dev/null", " && pwd -P"];
/// How the shell escapes a single quote inside a single-quoted string.
const ESCAPED_QUOTE: &str = "'\"'\"'";

/// One line of `ps`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessRow {
    pub pid: u32,
    pub ppid: u32,
    /// The process group the row belongs to. A shell tool that starts a
    /// command in its own group leaves the group leader as the command
    /// itself when the shell execs it (`pnpm test:unit`, `sleep 300`).
    pub pgid: u32,
    pub elapsed_secs: u64,
    pub command: String,
}

/// A task: a shell or command an agent started, with every process under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskProcess {
    pub pid: u32,
    pub session_id: String,
    pub command: String,
    pub elapsed_secs: u64,
    /// The task and its descendants, children before their parents, the task
    /// last: the order to signal them in.
    pub subtree: Vec<u32>,
}

/// A task as the UI shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundProcess {
    pub pid: u32,
    pub session_id: String,
    pub command: String,
    pub elapsed_secs: u64,
    /// The TCP ports the task's processes listen on.
    pub ports: Vec<u16>,
}

/// Splits off the first whitespace-separated field.
fn next_field(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start();
    if text.is_empty() {
        return None;
    }
    Some(text.split_once(char::is_whitespace).unwrap_or((text, "")))
}

/// Reads `ps -o pid=,ppid=,pgid=,etime=,command=` output; a line that does not
/// parse is left out.
pub fn parse_ps(output: &str) -> Vec<ProcessRow> {
    output.lines().filter_map(parse_ps_line).collect()
}

fn parse_ps_line(line: &str) -> Option<ProcessRow> {
    let (pid, rest) = next_field(line)?;
    let (ppid, rest) = next_field(rest)?;
    let (pgid, rest) = next_field(rest)?;
    let (etime, rest) = next_field(rest)?;
    Some(ProcessRow {
        pid: pid.parse().ok()?,
        ppid: ppid.parse().ok()?,
        pgid: pgid.parse().ok()?,
        elapsed_secs: parse_etime(etime)?,
        command: rest.trim().to_string(),
    })
}

/// Reads an elapsed time in `ps`'s `[[dd-]hh:]mm:ss` form, in seconds.
pub fn parse_etime(value: &str) -> Option<u64> {
    let (days, clock) = match value.split_once('-') {
        Some((days, clock)) => (days.parse::<u64>().ok()?, clock),
        None => (0, value),
    };
    let parts = clock
        .split(':')
        .map(|part| part.parse::<u64>().ok())
        .collect::<Option<Vec<u64>>>()?;
    let (hours, minutes, seconds) = match parts.as_slice() {
        [minutes, seconds] => (0, *minutes, *seconds),
        [hours, minutes, seconds] => (*hours, *minutes, *seconds),
        _ => return None,
    };
    Some(((days * 24 + hours) * 60 + minutes) * 60 + seconds)
}

/// Whether a command line runs a shell: its program's base name, a login
/// shell's leading `-` dropped.
fn is_shell(command: &str) -> bool {
    let program = command.split_whitespace().next().unwrap_or("");
    let name = program.rsplit('/').next().unwrap_or(program);
    SHELLS.contains(&name.trim_start_matches('-'))
}

/// The tasks under `roots`, each listed once under the first session whose
/// root reaches it; a root listed again (an agent several sessions share)
/// adds nothing.
pub fn select_tasks(rows: &[ProcessRow], roots: &[(String, u32)]) -> Vec<TaskProcess> {
    let children = children_by_parent(rows);

    let elapsed: HashMap<u32, u64> = rows.iter().map(|row| (row.pid, row.elapsed_secs)).collect();
    let mut seen_roots = HashSet::new();
    let mut listed = HashSet::new();
    let mut tasks = Vec::new();
    for (session_id, root) in roots {
        if !seen_roots.insert(*root) {
            continue;
        }
        for row in tasks_below(&children, *root, elapsed.get(root).copied()) {
            if listed.insert(row.pid) {
                tasks.push(TaskProcess {
                    pid: row.pid,
                    session_id: session_id.clone(),
                    command: row.command.clone(),
                    elapsed_secs: row.elapsed_secs,
                    subtree: subtree(&children, row.pid),
                });
            }
        }
    }
    tasks
}

/// Whether `row`, a shell under the root, launched the agent's own program:
/// it started together with the root, whose age is `root_elapsed`.
fn is_launcher(row: &ProcessRow, root_elapsed: Option<u64>) -> bool {
    root_elapsed.is_some_and(|root_elapsed| {
        root_elapsed.saturating_sub(row.elapsed_secs) <= LAUNCHER_START_SECS
    })
}

/// Whether `row` is work the agent started rather than part of its own launch:
/// a shell that did not launch the agent, or a command that leads its own
/// process group. A shell tool starts each command in its own group, and bash
/// execs a simple one, so `node …/pnpm test:unit` replaces the shell and only
/// the group leader is left. The agent's own program, MCP servers and helper
/// daemons inherit the agent's group, so they are looked through instead.
fn is_task(row: &ProcessRow, root_elapsed: Option<u64>) -> bool {
    if is_shell(&row.command) {
        return !is_launcher(row, root_elapsed);
    }
    row.pgid == row.pid
}

/// The tasks under `root` with no other task between them and it, a shell
/// that launched the agent itself looked through.
fn tasks_below<'a>(
    children: &HashMap<u32, Vec<&'a ProcessRow>>,
    root: u32,
    root_elapsed: Option<u64>,
) -> Vec<&'a ProcessRow> {
    let mut found = Vec::new();
    let mut visited = HashSet::from([root]);
    let mut stack: Vec<&ProcessRow> = children
        .get(&root)
        .into_iter()
        .flatten()
        .rev()
        .copied()
        .collect();
    while let Some(row) = stack.pop() {
        if !visited.insert(row.pid) {
            continue;
        }
        if is_task(row, root_elapsed) {
            found.push(row);
        } else if let Some(list) = children.get(&row.pid) {
            stack.extend(list.iter().rev().copied());
        }
    }
    found
}

/// Each process's children, by pid, keyed by parent. A process that is its
/// own parent (launchd's view of itself) is not a child of anything.
fn children_by_parent(rows: &[ProcessRow]) -> HashMap<u32, Vec<&ProcessRow>> {
    let mut children: HashMap<u32, Vec<&ProcessRow>> = HashMap::new();
    for row in rows.iter().filter(|row| row.pid != row.ppid) {
        children.entry(row.ppid).or_default().push(row);
    }
    children
        .values_mut()
        .for_each(|list| list.sort_by_key(|row| row.pid));
    children
}

/// `root` and every process under it in `rows`, each after all of its own
/// descendants, so `root` comes last: the order to signal them in.
pub fn subtree_of(rows: &[ProcessRow], root: u32) -> Vec<u32> {
    subtree(&children_by_parent(rows), root)
}

/// `pid` and its descendants, each after all of its own descendants.
fn subtree(children: &HashMap<u32, Vec<&ProcessRow>>, pid: u32) -> Vec<u32> {
    let mut order = Vec::new();
    let mut visited = HashSet::new();
    let mut stack = vec![(pid, false)];
    while let Some((current, expanded)) = stack.pop() {
        if expanded {
            order.push(current);
            continue;
        }
        if !visited.insert(current) {
            continue;
        }
        stack.push((current, true));
        if let Some(list) = children.get(&current) {
            stack.extend(list.iter().rev().map(|row| (row.pid, false)));
        }
    }
    order
}

/// The argument of the first `eval '…'`, its `'"'"'` escapes undone.
fn eval_argument(script: &str) -> Option<String> {
    let start = script.find("eval '")? + "eval '".len();
    let mut rest = &script[start..];
    let mut argument = String::new();
    loop {
        let end = rest.find('\'')?;
        argument.push_str(&rest[..end]);
        if rest[end..].starts_with(ESCAPED_QUOTE) {
            argument.push('\'');
            rest = &rest[end + ESCAPED_QUOTE.len()..];
        } else {
            return Some(argument);
        }
    }
}

/// True for `-c` and for combined flags that include it, like `-lc` or `-ic`.
fn runs_script(flag: &str) -> bool {
    flag.strip_prefix('-')
        .is_some_and(|letters| !letters.starts_with('-') && letters.contains('c'))
}

/// The text after a shell's `-c` (alone or combined, as in `-lc`) and the
/// `-l`/`-i` flags that follow it.
fn shell_script(raw: &str) -> Option<&str> {
    let (_, mut rest) = next_field(raw)?;
    loop {
        let (flag, after) = next_field(rest)?;
        rest = after;
        if runs_script(flag) {
            break;
        }
    }
    while let Some((flag, after)) = next_field(rest) {
        if flag != "-l" && flag != "-i" {
            break;
        }
        rest = after;
    }
    Some(rest.trim())
}

/// The command a shell was asked to run, without the wrapper an agent puts
/// around it, cut to `MAX_COMMAND_CHARS`.
pub fn display_command(raw: &str) -> String {
    let shown = match shell_script(raw) {
        Some(script) => match eval_argument(script) {
            Some(argument) => argument,
            None => {
                let end = WRAPPER_TAILS
                    .iter()
                    .filter_map(|tail| script.find(tail))
                    .min()
                    .unwrap_or(script.len());
                unquote(script[..end].trim()).to_string()
            }
        },
        None => raw.to_string(),
    };
    // `ps` writes a newline inside an argument as `\012`.
    let shown = shown.replace("\\012", " ");
    let shown = shown.trim();
    if shown.chars().count() <= MAX_COMMAND_CHARS {
        return shown.to_string();
    }
    let cut: String = shown.chars().take(MAX_COMMAND_CHARS - 1).collect();
    format!("{cut}…")
}

/// `text` without one pair of matching quotes around it.
fn unquote(text: &str) -> &str {
    ['"', '\'']
        .iter()
        .find_map(|quote| {
            text.strip_prefix(*quote)
                .and_then(|inner| inner.strip_suffix(*quote))
        })
        .unwrap_or(text)
}

/// Reads `lsof -Fpn` output into each pid's listening ports, sorted.
pub fn parse_lsof_ports(output: &str) -> HashMap<u32, Vec<u16>> {
    let mut ports: HashMap<u32, Vec<u16>> = HashMap::new();
    let mut current = None;
    for line in output.lines() {
        if let Some(pid) = line.strip_prefix('p') {
            current = pid.parse::<u32>().ok();
        } else if let (Some(pid), Some(name)) = (current, line.strip_prefix('n')) {
            if let Some(port) = name.rsplit(':').next().and_then(|p| p.parse().ok()) {
                ports.entry(pid).or_default().push(port);
            }
        }
    }
    ports.values_mut().for_each(|list| {
        list.sort_unstable();
        list.dedup();
    });
    ports
}

/// Every process, from `ps`.
#[cfg(target_os = "macos")]
pub fn read_processes() -> Result<Vec<ProcessRow>, String> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,pgid=,etime=,command="])
        .output()
        .map_err(|e| format!("Could not list processes: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not list processes: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(parse_ps(&String::from_utf8_lossy(&output.stdout)))
}

/// Tasks are only looked for on macOS.
#[cfg(not(target_os = "macos"))]
pub fn read_processes() -> Result<Vec<ProcessRow>, String> {
    Ok(Vec::new())
}

/// The TCP ports `pids` listen on. lsof exits non-zero when one of the pids
/// listens on nothing, so its output is read whatever its status; not being
/// able to run it means no ports. `-b` keeps a stale network mount from
/// blocking every scan, and `-w` drops the warnings that come with it.
fn listening_ports(pids: &[u32]) -> HashMap<u32, Vec<u16>> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let list = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    Command::new("/usr/sbin/lsof")
        .args([
            "-b",
            "-w",
            "-nP",
            "-a",
            "-p",
            &list,
            "-iTCP",
            "-sTCP:LISTEN",
            "-Fpn",
        ])
        .stderr(Stdio::null())
        .output()
        .map(|output| parse_lsof_ports(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default()
}

/// The tasks running under `roots` (session id, agent pid), with the ports
/// they listen on when `with_ports` (lsof is the slow part of a scan, and
/// only the open menu shows ports).
pub fn scan(roots: &[(String, u32)], with_ports: bool) -> Result<Vec<BackgroundProcess>, String> {
    let tasks = select_tasks(&read_processes()?, roots);
    let ports = if with_ports {
        let pids: Vec<u32> = tasks.iter().flat_map(|task| task.subtree.clone()).collect();
        listening_ports(&pids)
    } else {
        HashMap::new()
    };
    Ok(tasks
        .into_iter()
        .map(|task| {
            let mut task_ports: Vec<u16> = task
                .subtree
                .iter()
                .filter_map(|pid| ports.get(pid))
                .flatten()
                .copied()
                .collect();
            task_ports.sort_unstable();
            task_ports.dedup();
            BackgroundProcess {
                pid: task.pid,
                session_id: task.session_id,
                command: display_command(&task.command),
                elapsed_secs: task.elapsed_secs,
                ports: task_ports,
            }
        })
        .collect())
}

/// Sends `signal` to `pids` with `/bin/kill`. kill exits non-zero when any
/// one pid is not reached (one that exited since the scan, or one this user
/// may not signal) yet still signals the rest, so only failing to run it is
/// an error.
fn send_signal(signal: &str, pids: &[u32]) -> Result<(), String> {
    Command::new("/bin/kill")
        .arg(signal)
        .args(pids.iter().map(u32::to_string))
        .stderr(Stdio::null())
        .status()
        .map(|_| ())
        .map_err(|e| format!("Could not run kill: {e}"))
}

/// Stops the task `pid` under `roots`, if a fresh scan still lists it; see
/// `terminate`.
pub fn stop(roots: &[(String, u32)], pid: u32) -> Result<(), String> {
    let rows = read_processes()?;
    let task = select_tasks(&rows, roots)
        .into_iter()
        .find(|task| task.pid == pid)
        .ok_or_else(|| format!("Process {pid} is no longer running"))?;
    terminate(&task, &rows)
}

/// Sends `TERM` to `task` and everything under it, then, after
/// `KILL_GRACE`, `KILL` to whichever of them `rows` (the scan `task` came
/// from) lists and is still the same process: same command, running at
/// least as long. The escalation is scheduled whenever `TERM` was sent; an
/// error means kill could not be run at all.
pub fn terminate(task: &TaskProcess, rows: &[ProcessRow]) -> Result<(), String> {
    let members: Vec<ProcessRow> = task
        .subtree
        .iter()
        .filter_map(|member| rows.iter().find(|row| row.pid == *member).cloned())
        .collect();

    // Whatever ignored or missed TERM is left to the KILL below.
    send_signal("-TERM", &task.subtree)?;

    thread::spawn(move || {
        thread::sleep(KILL_GRACE);
        // Nothing can be shown from here, so a failure is logged; without a
        // fresh read the KILL is skipped rather than sent to reused pids.
        let now = match read_processes() {
            Ok(now) => now,
            Err(error) => {
                eprintln!("Could not check what is left of the stopped task to KILL: {error}");
                return;
            }
        };
        let lingering: Vec<u32> = members
            .iter()
            .filter(|before| {
                now.iter().any(|row| {
                    row.pid == before.pid
                        && row.command == before.command
                        && row.elapsed_secs >= before.elapsed_secs
                })
            })
            .map(|row| row.pid)
            .collect();
        if lingering.is_empty() {
            return;
        }
        if let Err(error) = send_signal("-KILL", &lingering) {
            eprintln!("Could not KILL what is left of the stopped task {lingering:?}: {error}");
        }
    });
    Ok(())
}

/// Ends `root` and everything under it, as a fresh read of the processes
/// lists them. With `grace`, TERM now and KILL the survivors after
/// `KILL_GRACE`, through `terminate`. Without it, KILL at once, for a quit
/// that cannot wait for a thread to run.
pub fn end_tree(root: u32, grace: bool) -> Result<(), String> {
    let rows = read_processes()?;
    let subtree = subtree_of(&rows, root);
    if !grace {
        return send_signal("-KILL", &subtree);
    }
    let (command, elapsed_secs) = rows
        .iter()
        .find(|row| row.pid == root)
        .map(|row| (row.command.clone(), row.elapsed_secs))
        .unwrap_or_default();
    let task = TaskProcess {
        pid: root,
        session_id: String::new(),
        command,
        elapsed_secs,
        subtree,
    };
    terminate(&task, &rows)
}

/// Every running agent's pid, by the app session it serves.
fn session_roots(acp: &AcpManager) -> Vec<(String, u32)> {
    acp.root_pids()
}

/// The shell commands agents started that are still running, with their
/// listening ports unless `with_ports` is false.
#[tauri::command(async)]
pub fn background_processes(
    acp: State<'_, AcpManager>,
    with_ports: Option<bool>,
) -> Result<Vec<BackgroundProcess>, String> {
    scan(&session_roots(&acp), with_ports.unwrap_or(true))
}

/// Stops one of the tasks `background_processes` lists.
#[tauri::command(async)]
pub fn stop_background_process(acp: State<'_, AcpManager>, pid: u32) -> Result<(), String> {
    stop(&session_roots(&acp), pid)
}
