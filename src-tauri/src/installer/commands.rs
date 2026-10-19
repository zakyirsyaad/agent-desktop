//! The installer's Tauri commands and its progress event. The webview names
//! only an agent id or a runtime kind; every step comes from the catalog, the
//! manifest compiled into the app and the prerequisite table.

use std::collections::BTreeMap;

use tauri::{AppHandle, Emitter, Manager, State};

use super::archive::UnpackLimits;
use super::cleanup::{cleanup_inputs, prereqs_needed_by};
use super::download::DownloadLimits;
use super::install::{InstallProgress, Installer};
use super::layout::ToolsDir;
use super::plan::PlannedStep;
use super::runtimes::RuntimeKind;
use super::{bundled_manifest, installed_tools};
use crate::acp::manager::AcpManager;
use crate::env_resolver::cached_user_env;
use crate::profiles::{agent_profiles, install_steps_for};
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
/// so the webview cannot choose what is downloaded.
#[tauri::command(async)]
pub fn install_agent(
    app: AppHandle,
    store: State<'_, AppStore>,
    installer: State<'_, AppInstaller>,
    agent_id: String,
) -> Result<(), String> {
    let installer = installer.get()?;
    let id = canonical_agent_id(&agent_id);
    let (name, steps) = install_steps_for(id, &versions_in_use(&store))
        .ok_or_else(|| format!("Unknown agent '{agent_id}'"))?;
    if steps.is_empty() {
        return Err(format!("{name} is already installed"));
    }
    run_job(&app, installer, id, &steps)
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
    let installed = installed_tools();
    let pinned_installed = match runtime {
        RuntimeKind::Node => installed.pinned_node_installed,
        RuntimeKind::Uv => installed.pinned_uv_installed,
    };
    if pinned_installed {
        return Ok(());
    }
    let job_id = format!("runtime:{kind}");
    run_job(&app, installer, &job_id, &[PlannedStep::Runtime(runtime)])
}

/// Asks the job `agent_id` (an agent id, or `runtime:<kind>`) to stop; false
/// when it is not running. Sync: it only sets a flag.
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
    installer.cancel(id);
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
    let _ = app.emit(AGENT_PROFILES_CHANGED, ());
    Ok(())
}

/// Runs `steps` as the job `job_id` with the user's environment, reporting
/// progress to the UI and telling it to reload the profiles on success.
fn run_job(
    app: &AppHandle,
    installer: &Installer,
    job_id: &str,
    steps: &[PlannedStep],
) -> Result<(), String> {
    let env = cached_user_env().unwrap_or_else(|_| std::env::vars().collect());
    let user_node_major = installed_tools().user_node_major;
    let report = |progress: InstallProgress| {
        let _ = app.emit(AGENT_INSTALL_PROGRESS, progress);
    };
    installer.run(job_id, steps, &env, user_node_major, &report)?;
    let _ = app.emit(AGENT_PROFILES_CHANGED, ());
    Ok(())
}

/// Deletes what no enabled agent uses any more. Runs once at start, on the
/// background thread after the catalog refresh, so the versions in use are
/// the ones the UI shows. Logs failures and never blocks start.
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
    if installer.clean_up(&inputs).is_none() {
        eprintln!("Skipped the clean-up of old installs: an install is running");
    }
}
