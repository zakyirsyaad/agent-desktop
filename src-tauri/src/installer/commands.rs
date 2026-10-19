//! The installer's Tauri commands and its progress event. The webview names
//! only an agent id or a runtime kind; every step comes from the catalog, the
//! manifest compiled into the app and the prerequisite table.

use std::collections::BTreeMap;

use tauri::{AppHandle, Emitter, Manager, State};

use super::archive::UnpackLimits;
use super::cleanup::{cleanup_inputs, prereqs_needed_by};
use super::download::DownloadLimits;
use super::install::{InstallProgress, Installer, Job};
use super::layout::ToolsDir;
use super::plan::PlannedStep;
use super::runtimes::RuntimeKind;
use super::{bundled_manifest, user_node_major};
use crate::acp::manager::AcpManager;
use crate::env_resolver::cached_user_env;
use crate::profiles::{agent_name, agent_profiles, install_steps_for};
use crate::registry::resolve::canonical_agent_id;
use crate::registry::schema::current_platform;
use crate::registry::AGENT_PROFILES_CHANGED;
use crate::store::AppStore;

/// Carries an [`InstallProgress`] for each phase of each step.
pub const AGENT_INSTALL_PROGRESS: &str = "agent-install-progress";

/// Why every install fails when the manifest compiled into the app does not parse.
const NO_MANIFEST: &str = "Zorvo's runtime list is not valid";

/// The app's one installer. Without one (the bundled manifest is not valid)
/// the app still starts, and every install fails with [`NO_MANIFEST`].
pub struct AppInstaller(Option<Installer>);

impl AppInstaller {
    /// Production limits, the bundled manifest and this Mac's platform.
    pub fn new(tools: ToolsDir) -> Self {
        Self(bundled_manifest().cloned().map(|manifest| {
            Installer::new(
                tools,
                manifest,
                current_platform().to_string(),
                DownloadLimits::production(),
                UnpackLimits::production(),
            )
        }))
    }

    fn get(&self) -> Result<&Installer, String> {
        self.0.as_ref().ok_or_else(|| NO_MANIFEST.to_string())
    }
}

/// The registry version in use for each agent id. A failed read falls back
/// to the offered versions, as the profiles the UI shows do.
pub fn versions_in_use(store: &AppStore) -> BTreeMap<String, String> {
    store
        .load_state()
        .map(|state| state.settings.agent_versions)
        .unwrap_or_else(|error| {
            eprintln!("Could not read the agent versions in use: {error}");
            BTreeMap::new()
        })
}

/// Installs what the agent needs, planned again here from the version in use
/// so the webview cannot choose what is downloaded. The job begins before the
/// plan is made (planning can wait on the user's Node), so a Cancel meanwhile
/// finds it.
#[tauri::command(async)]
pub fn install_agent(
    app: AppHandle,
    store: State<'_, AppStore>,
    installer: State<'_, AppInstaller>,
    agent_id: String,
) -> Result<(), String> {
    let installer = installer.get()?;
    let id = canonical_agent_id(&agent_id);
    let unknown = || format!("Unknown agent '{agent_id}'");
    let versions = versions_in_use(&store);
    let job = installer.begin(id, &agent_name(id, &versions).ok_or_else(unknown)?)?;
    let (_, steps) = install_steps_for(id, &versions).ok_or_else(unknown)?;
    run_plan(
        &steps,
        |steps| run_with_user_env(&app, installer, &job, steps),
        || profiles_changed(&app),
    )
}

/// Runs the plan with `run`, then calls `notify` however it ended: a failed
/// or cancelled job may have installed its first steps, which changes the
/// plan the UI shows. An empty plan means the agent is installed already (the
/// UI's plan was stale), so there is nothing to run, only a reload.
fn run_plan(
    steps: &[PlannedStep],
    run: impl FnOnce(&[PlannedStep]) -> Result<(), String>,
    notify: impl FnOnce(),
) -> Result<(), String> {
    let result = if steps.is_empty() { Ok(()) } else { run(steps) };
    notify();
    result
}

/// Tells the UI to reload the profiles, whose availability and plans changed.
fn profiles_changed(app: &AppHandle) {
    let _ = app.emit(AGENT_PROFILES_CHANGED, ());
}

/// Installs Zorvo's pinned `node` or `uv`, as the job `runtime:<kind>`.
/// Resolves at once when it is already installed.
#[tauri::command(async)]
pub fn install_runtime(
    app: AppHandle,
    installer: State<'_, AppInstaller>,
    kind: String,
) -> Result<(), String> {
    let runtime = RuntimeKind::parse(&kind).ok_or_else(|| format!("Unknown runtime '{kind}'"))?;
    let installer = installer.get()?;
    let steps = [PlannedStep::Runtime(runtime)];
    let job = installer.begin(&format!("runtime:{kind}"), &installer.plan_name(&steps))?;
    if installer.pinned_runtime_installed(runtime) {
        return Ok(());
    }
    run_plan(
        &steps,
        |steps| run_with_user_env(&app, installer, &job, steps),
        || profiles_changed(&app),
    )
}

/// Asks the job `agent_id` (an agent id, or `runtime:<kind>`) to stop; false
/// when it has not begun or has ended. Sync: it only takes the job map's short lock.
#[tauri::command]
pub fn cancel_agent_install(installer: State<'_, AppInstaller>, agent_id: String) -> bool {
    installer
        .get()
        .is_ok_and(|installer| installer.cancel(canonical_agent_id(&agent_id)))
}

/// Deletes Zorvo's copy of the agent and the prerequisites no other enabled
/// agent needs. While a session runs the agent from its dir nothing is
/// deleted: the clean-up at the next start does it once the agent is disabled.
#[tauri::command(async)]
pub fn remove_agent_install(
    app: AppHandle,
    store: State<'_, AppStore>,
    acp: State<'_, AcpManager>,
    installer: State<'_, AppInstaller>,
    agent_id: String,
) -> Result<(), String> {
    let installer = installer.get()?;
    let id = canonical_agent_id(&agent_id);
    installer.stop_if_running(id);
    if acp.is_running_under(&installer.tools().root().join("agents").join(id)) {
        return Ok(());
    }
    let others: Vec<String> = store
        .load_state()?
        .settings
        .enabled_agent_ids()
        .into_iter()
        .filter(|other| other != id)
        .collect();
    installer.remove_agent(id, &prereqs_needed_by(&others))?;
    profiles_changed(&app);
    Ok(())
}

/// Runs `steps` in `job` with the user's environment, reporting progress to
/// the UI.
fn run_with_user_env(
    app: &AppHandle,
    installer: &Installer,
    job: &Job,
    steps: &[PlannedStep],
) -> Result<(), String> {
    let env = cached_user_env().unwrap_or_else(|_| std::env::vars().collect());
    let user_node_major = user_node_major();
    let report = |progress: InstallProgress| {
        let _ = app.emit(AGENT_INSTALL_PROGRESS, progress);
    };
    installer.run_job(job, steps, &env, user_node_major, &report)
}

/// Deletes what no enabled agent uses any more. Runs once at start, on the
/// background thread after the catalog refresh, so the versions in use are
/// the ones the UI shows, and skips any install an agent is running from.
/// Logs failures and never blocks start.
pub fn clean_up_at_start(app: &AppHandle) {
    let state = app.state::<AppInstaller>();
    let installer = match state.get() {
        Ok(installer) => installer,
        Err(error) => {
            eprintln!("Skipped the clean-up of old installs: {error}");
            return;
        }
    };
    // Without the settings every agent would look disabled.
    let settings = match app.state::<AppStore>().load_state() {
        Ok(state) => state.settings,
        Err(error) => {
            eprintln!("Skipped the clean-up of old installs: {error}");
            return;
        }
    };
    let inputs = cleanup_inputs(&settings, &agent_profiles(&settings.agent_versions));
    // A refresh may have moved an agent off the version a session already
    // runs from; that install stays until the next start.
    let acp = app.state::<AcpManager>();
    if installer
        .clean_up(&inputs, &|dir| acp.is_running_under(dir))
        .is_none()
    {
        eprintln!("Skipped the clean-up of old installs: an install is running");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    use super::super::install::INSTALL_CANCELLED;

    fn node() -> Vec<PlannedStep> {
        vec![PlannedStep::Runtime(RuntimeKind::Node)]
    }

    #[test]
    fn a_failed_or_cancelled_plan_still_tells_the_ui_to_reload() {
        for error in ["Checksum mismatch for Node.js", INSTALL_CANCELLED] {
            let notified = Cell::new(false);
            let result = run_plan(&node(), |_| Err(error.to_string()), || notified.set(true));
            assert_eq!(result, Err(error.to_string()));
            assert!(notified.get(), "{error}: the plan may have changed");
        }
    }

    #[test]
    fn an_empty_plan_means_installed_and_reloads_without_running() {
        let notified = Cell::new(false);
        let result = run_plan(&[], |_| panic!("nothing to run"), || notified.set(true));
        assert_eq!(result, Ok(()));
        assert!(notified.get());
    }

    #[test]
    fn a_successful_plan_reloads() {
        let notified = Cell::new(false);
        assert_eq!(run_plan(&node(), |_| Ok(()), || notified.set(true)), Ok(()));
        assert!(notified.get());
    }
}
