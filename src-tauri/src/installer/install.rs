//! Runs an install plan step by step: the runtime, then prerequisites, then
//! the agent's archive.
//!
//! Each step takes its target's lock and then checks the disk again, so two
//! plans that both need Node download it once: the second waits and finds it
//! there. Plans for different targets run in parallel. A job can be cancelled
//! while it downloads, unpacks, runs npm or waits for a lock.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::archive::{ensure_agent_command, format_for_url, unpack, UnpackLimits};
use super::cleanup::{clean_up, CleanupInputs};
use super::download::{download, DownloadLimits};
use super::layout::{read_record, CommitOutcome, InstallRecord, Staging, ToolsDir};
use super::plan::PlannedStep;
use super::prerequisites::{
    npm_install_args, prerequisites_for, run_npm_install, Prerequisite, NPM_INSTALL_TIMEOUT,
};
use super::runtimes::{installed_runtime, RuntimeKind, RuntimeManifest, MIN_USER_NODE_MAJOR};
use crate::env_resolver::find_binary_in_path_str;

/// What a cancelled run returns, so the UI can tell it from a failure.
pub const INSTALL_CANCELLED: &str = "INSTALL_CANCELLED";

const UNKNOWN_FORMAT: &str = "Zorvo cannot unpack this archive format";

/// How often a job waiting for another job's target checks its cancel flag.
const LOCK_POLL: Duration = Duration::from_millis(50);

const PHASE_DOWNLOAD: &str = "download";
const PHASE_VERIFY: &str = "verify";
const PHASE_UNPACK: &str = "unpack";
const PHASE_NPM: &str = "npm";

/// The payload of the `agent-install-progress` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub agent_id: String,
    pub step_index: usize,
    pub step_count: usize,
    pub kind: String,
    pub name: String,
    /// `download`, `verify`, `unpack` or `npm`.
    pub phase: String,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
}

pub struct Installer {
    tools: ToolsDir,
    manifest: RuntimeManifest,
    platform: String,
    download: DownloadLimits,
    unpack: UnpackLimits,
    /// One lock per target: `node`, `uv`, `agent:<id>`, `prereq:<command>`.
    /// Entries are never removed; there are only as many as targets.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// The cancel flag of each running job.
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Installer {
    pub fn new(
        tools: ToolsDir,
        manifest: RuntimeManifest,
        platform: String,
        download: DownloadLimits,
        unpack: UnpackLimits,
    ) -> Self {
        Self {
            tools,
            manifest,
            platform,
            download,
            unpack,
            locks: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
        }
    }

    /// Runs `steps` in order as the job `job_id`. `user_node_major` decides
    /// whose npm installs prerequisites. Returns [`INSTALL_CANCELLED`] when
    /// the job is cancelled, else the first step's readable error.
    pub fn run(
        &self,
        job_id: &str,
        steps: &[PlannedStep],
        env: &HashMap<String, String>,
        user_node_major: Option<u32>,
        on_progress: &(dyn Fn(InstallProgress) + Sync),
    ) -> Result<(), String> {
        let job = self.start_job(job_id)?;
        let cancel = job.cancel.as_ref();
        for (index, step) in steps.iter().enumerate() {
            let shown = step.display(Some(&self.manifest), &self.platform);
            let run = StepRun {
                job_id,
                index,
                count: steps.len(),
                kind: shown.kind,
                name: shown.name,
                cancel,
                on_progress,
            };
            self.run_step(step, &run, env, user_node_major)
                .map_err(|e| {
                    if cancel.load(Ordering::Relaxed) {
                        INSTALL_CANCELLED.to_string()
                    } else {
                        e
                    }
                })?;
        }
        Ok(())
    }

    /// Asks the job to stop; false when no such job is running.
    pub fn cancel(&self, job_id: &str) -> bool {
        match lock(&self.jobs).get(job_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// The tools dir this installer writes to.
    pub fn tools(&self) -> &ToolsDir {
        &self.tools
    }

    /// Runs the clean-up at start while no job runs, holding off new jobs
    /// until it ends, so it never deletes a staging dir or an install a job
    /// is writing. `None` when a job was running; else the errors it logged.
    pub fn clean_up(&self, inputs: &CleanupInputs) -> Option<Vec<String>> {
        let jobs = lock(&self.jobs);
        jobs.is_empty()
            .then(|| clean_up(&self.tools, &self.manifest, &self.platform, inputs))
    }

    /// Deletes every installed version of the agent, and those of its
    /// prerequisites that are not in `prereqs_still_needed`. Nothing outside
    /// `tools/agents/<id>` and `tools/prereqs/<command>` is touched.
    pub fn remove_agent(
        &self,
        agent_id: &str,
        prereqs_still_needed: &BTreeSet<String>,
    ) -> Result<(), String> {
        if !is_single_name(agent_id) {
            return Err(format!("{agent_id:?} is not an agent id"));
        }
        {
            let target = self.target_lock(&format!("agent:{agent_id}"));
            let _held = lock(&target);
            remove_dir(&self.tools.root().join("agents").join(agent_id))?;
        }
        for p in prerequisites_for(agent_id) {
            if prereqs_still_needed.contains(p.command) {
                continue;
            }
            let target = self.target_lock(&format!("prereq:{}", p.command));
            let _held = lock(&target);
            remove_dir(&self.tools.root().join("prereqs").join(p.command))?;
        }
        Ok(())
    }

    fn start_job(&self, job_id: &str) -> Result<Job<'_>, String> {
        let mut jobs = lock(&self.jobs);
        if jobs.contains_key(job_id) {
            return Err(format!("{job_id} is already installing"));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.insert(job_id.to_string(), Arc::clone(&cancel));
        Ok(Job {
            jobs: &self.jobs,
            id: job_id.to_string(),
            cancel,
        })
    }

    /// The target's lock, cloned out so the map is never held while waiting.
    fn target_lock(&self, key: &str) -> Arc<Mutex<()>> {
        Arc::clone(lock(&self.locks).entry(key.to_string()).or_default())
    }

    fn run_step(
        &self,
        step: &PlannedStep,
        run: &StepRun,
        env: &HashMap<String, String>,
        user_node_major: Option<u32>,
    ) -> Result<(), String> {
        if !has_plain_path_parts(step) {
            return Err(format!(
                "Zorvo cannot install {}: its id or version is not a plain name",
                run.name
            ));
        }
        let target = self.target_lock(&lock_key(step));
        let _held = wait_for(&target, run.cancel)?;
        run.check_cancel()?;
        match step {
            PlannedStep::Runtime(kind) => self.install_runtime(*kind, run),
            PlannedStep::Agent {
                id,
                version,
                url,
                sha256,
                cmd,
                ..
            } => {
                let dest = self.tools.agent_dir(id, version);
                if read_record(&dest).is_some() {
                    return Ok(());
                }
                let staging = self.fetch(run, url, sha256, None)?;
                ensure_agent_command(&staging.content_path(), cmd)
                    .map_err(|e| e.user_message(&run.name, cmd))?;
                commit(run, staging, &dest, record(url, Some(sha256), None))
            }
            PlannedStep::Prerequisite(p) => self.install_prerequisite(p, run, env, user_node_major),
        }
    }

    fn install_runtime(&self, kind: RuntimeKind, run: &StepRun) -> Result<(), String> {
        let release = self.manifest.release(kind);
        let dest = kind.dir(&self.tools, &release.version, &self.platform);
        if read_record(&dest).is_some() {
            return Ok(());
        }
        let target = release
            .targets
            .get(&self.platform)
            .ok_or_else(|| format!("Zorvo has no {} download for this Mac", run.name))?;
        let staging = self.fetch(run, &target.url, &target.sha256, Some(target.size))?;
        let installed = record(&target.url, Some(&target.sha256), Some(&target.bin));
        commit(run, staging, &dest, installed)
    }

    /// Downloads, verifies and unpacks an archive into a new staging dir.
    /// `size` stands in for a missing `Content-Length`.
    fn fetch(
        &self,
        run: &StepRun,
        url: &str,
        sha256: &str,
        size: Option<u64>,
    ) -> Result<Staging, String> {
        // Fail before spending the download on an archive that cannot be unpacked.
        let format = format_for_url(url).ok_or(UNKNOWN_FORMAT)?;
        let staging = self.tools.new_staging()?;
        let archive = staging.download_path();
        run.report(PHASE_DOWNLOAD, 0, size);
        let mut seen = (0, size);
        download(
            url,
            sha256,
            &archive,
            &self.download,
            run.cancel,
            &mut |received, total| {
                seen = (received, total.or(size));
                run.report(PHASE_DOWNLOAD, seen.0, seen.1);
            },
        )
        .map_err(|e| e.user_message(&run.name))?;
        // The download already compared the hash; this tells the UI it matched.
        run.report(PHASE_VERIFY, seen.0, seen.1);
        run.check_cancel()?;
        run.report(PHASE_UNPACK, seen.0, seen.1);
        unpack(
            &archive,
            format,
            &staging.content_path(),
            &self.unpack,
            run.cancel,
        )
        .map_err(|e| e.user_message(&run.name))?;
        Ok(staging)
    }

    fn install_prerequisite(
        &self,
        p: &Prerequisite,
        run: &StepRun,
        env: &HashMap<String, String>,
        user_node_major: Option<u32>,
    ) -> Result<(), String> {
        let dest = self.tools.prereq_dir(p.command, p.version);
        if read_record(&dest).is_some() {
            return Ok(());
        }
        let (npm, npm_env) = self.npm_for(p, env, user_node_major)?;
        let staging = self.tools.new_staging()?;
        run.report(PHASE_NPM, 0, None);
        let args = npm_install_args(&staging.content_path(), p);
        run_npm_install(&npm, &args, &npm_env, NPM_INSTALL_TIMEOUT, run.cancel)?;
        let source = format!("npm:{}@{}", p.package, p.version);
        commit(run, staging, &dest, record(&source, None, None))
    }

    /// The user's npm when their Node is new enough, else Zorvo's, read from
    /// disk now so a Node installed by an earlier step counts. Zorvo's bin
    /// dir goes first on `PATH` so npm's scripts run with that Node.
    fn npm_for(
        &self,
        p: &Prerequisite,
        env: &HashMap<String, String>,
        user_node_major: Option<u32>,
    ) -> Result<(PathBuf, HashMap<String, String>), String> {
        let path = env.get("PATH").map_or("", String::as_str);
        let users_node = user_node_major.is_some_and(|major| major >= MIN_USER_NODE_MAJOR);
        if users_node {
            if let Some(npm) = find_binary_in_path_str("npm", path) {
                return Ok((npm, env.clone()));
            }
        }
        let node = installed_runtime(
            &self.tools,
            RuntimeKind::Node,
            &self.manifest,
            &self.platform,
        )
        .ok_or_else(|| {
            if users_node {
                format!("{} needs npm, which is not on your PATH", p.command)
            } else {
                format!("{} needs Node.js, which is not installed", p.command)
            }
        })?;
        let bin = node.bin_dir.display().to_string();
        let joined = if path.is_empty() {
            bin
        } else {
            format!("{bin}:{path}")
        };
        let npm_env = env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .chain([("PATH".to_string(), joined)])
            .collect();
        Ok((node.bin_dir.join("npm"), npm_env))
    }
}

/// A running job's entry in the job map, removed when the run ends.
struct Job<'a> {
    jobs: &'a Mutex<HashMap<String, Arc<AtomicBool>>>,
    id: String,
    cancel: Arc<AtomicBool>,
}

impl Drop for Job<'_> {
    fn drop(&mut self) {
        lock(self.jobs).remove(&self.id);
    }
}

/// One step of a running job: where its progress goes and its cancel flag.
struct StepRun<'a> {
    job_id: &'a str,
    index: usize,
    count: usize,
    kind: String,
    name: String,
    cancel: &'a AtomicBool,
    on_progress: &'a (dyn Fn(InstallProgress) + Sync),
}

impl StepRun<'_> {
    fn report(&self, phase: &str, received_bytes: u64, total_bytes: Option<u64>) {
        (self.on_progress)(InstallProgress {
            agent_id: self.job_id.to_string(),
            step_index: self.index,
            step_count: self.count,
            kind: self.kind.clone(),
            name: self.name.clone(),
            phase: phase.to_string(),
            received_bytes,
            total_bytes,
        });
    }

    fn check_cancel(&self) -> Result<(), String> {
        check_cancel(self.cancel)
    }
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err(INSTALL_CANCELLED.to_string())
    } else {
        Ok(())
    }
}

/// True when the parts of the step joined into its install path are each one
/// plain name, so the path stays under `tools/`. Runtime versions come from
/// the manifest compiled into the app.
fn has_plain_path_parts(step: &PlannedStep) -> bool {
    match step {
        PlannedStep::Runtime(_) => true,
        PlannedStep::Agent { id, version, .. } => is_single_name(id) && is_single_name(version),
        PlannedStep::Prerequisite(p) => is_single_name(p.command) && is_single_name(p.version),
    }
}

fn lock_key(step: &PlannedStep) -> String {
    match step {
        PlannedStep::Runtime(RuntimeKind::Node) => "node".to_string(),
        PlannedStep::Runtime(RuntimeKind::Uv) => "uv".to_string(),
        PlannedStep::Agent { id, .. } => format!("agent:{id}"),
        PlannedStep::Prerequisite(p) => format!("prereq:{}", p.command),
    }
}

/// Takes `target`, giving up as soon as `cancel` is set, so a job queued
/// behind another job's long download can still be cancelled.
fn wait_for<'a>(target: &'a Mutex<()>, cancel: &AtomicBool) -> Result<MutexGuard<'a, ()>, String> {
    loop {
        match target.try_lock() {
            Ok(guard) => return Ok(guard),
            // The lock guards no data; a panicked holder left nothing half-done
            // outside its own staging dir.
            Err(TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => {
                check_cancel(cancel)?;
                thread::sleep(LOCK_POLL);
            }
        }
    }
}

/// Moves the staging content to `dest`, under the target's lock.
///
/// The caller found no record at `dest`, so anything there is left over from
/// a failed removal or a deleted `install.json`. It is removed first, since it
/// would otherwise block the rename and the step would never install.
fn commit(
    run: &StepRun,
    staging: Staging,
    dest: &Path,
    record: InstallRecord,
) -> Result<(), String> {
    run.check_cancel()?;
    if read_record(dest).is_none() {
        remove_leftover(dest)?;
    }
    match staging.commit(dest, &record)? {
        CommitOutcome::Installed => Ok(()),
        // Only another process could have put it there; count it if it is complete.
        CommitOutcome::AlreadyPresent if read_record(dest).is_some() => Ok(()),
        CommitOutcome::AlreadyPresent => Err(format!(
            "Could not install {}: something else is at {}",
            run.name,
            dest.display()
        )),
    }
}

/// Deletes whatever is at `dest` without following a symlink there.
fn remove_leftover(dest: &Path) -> Result<(), String> {
    let removed = match fs::symlink_metadata(dest) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(dest),
        Ok(_) => fs::remove_file(dest),
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => Err(e),
    };
    removed.map_err(|e| {
        format!(
            "Could not remove the incomplete install at {}: {e}",
            dest.display()
        )
    })
}

fn record(source: &str, sha256: Option<&str>, bin: Option<&str>) -> InstallRecord {
    InstallRecord {
        source: source.to_string(),
        sha256: sha256.map(String::from),
        installed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs()),
        bin: bin.map(String::from),
    }
}

fn remove_dir(dir: &Path) -> Result<(), String> {
    match fs::remove_dir_all(dir) {
        Err(e) if e.kind() != ErrorKind::NotFound => {
            Err(format!("Could not remove {}: {e}", dir.display()))
        }
        _ => Ok(()),
    }
}

/// True for exactly one plain path component, so a join stays one level down.
fn is_single_name(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

// Every write replaces or removes a whole entry, so a poisoned map is still usable.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
