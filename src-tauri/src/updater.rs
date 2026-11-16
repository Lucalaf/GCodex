//! In-app self-updater for GCodex.
//!
//! On startup the app quietly asks GitHub for the newest published release and
//! compares it against the version this binary was built with. If a newer
//! release exists the frontend is told via the `update-available` event and
//! renders its own modal. When the user accepts, the RPM asset is downloaded
//! and installed with `pkexec dnf upgrade -y`, so Fedora's standard
//! authentication dialog handles the privilege escalation.
//!
//! The check is best-effort: a missing network, a rate-limited GitHub API or an
//! unparseable payload must never stop the app from opening. Every failure is
//! reported to the caller as a `None` / `Err` and swallowed by the spawner.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// GitHub repository that publishes GCodex releases.
const RELEASE_OWNER: &str = "Lucalaf";
const RELEASE_REPO: &str = "GCodex";

/// Event emitted to the frontend when a newer release is published.
pub const UPDATE_AVAILABLE_EVENT: &str = "update-available";
/// Event emitted with download/install progress so the modal can show it.
pub const UPDATE_PROGRESS_EVENT: &str = "update-progress";

/// Version of the running binary.
///
/// This must be the *app's* version (`0.1.0`), not Tauri's — `tauri::VERSION`
/// is the version of the Tauri crate itself (e.g. `2.12.5`), which would make
/// every release look older than the running app and silently disable updates.
/// Tauri requires `tauri.conf.json`'s `version` to match `Cargo.toml`, so the
/// crate version baked in at compile time is the correct source of truth.
pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    /// Version string of the newest release, without a leading `v`.
    pub version: String,
    /// Human-readable release title or tag, for the modal heading.
    pub title: String,
    /// Release notes as published on GitHub (may be empty).
    pub notes: String,
    /// Browser URL of the release page, used as a fallback / "details" link.
    pub html_url: String,
    /// Direct download URL of the `.rpm` asset, when the release has one.
    pub rpm_url: Option<String>,
    /// Size of the `.rpm` asset in bytes, when known.
    pub rpm_size: Option<u64>,
}

/// Reply to the manual "check for updates" command.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    /// `Some` only when the published release is newer than this build.
    pub update: Option<UpdateInfo>,
}

/// Progress reported while downloading and installing.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    /// "downloading" | "installing" | "done" | "error"
    pub stage: String,
    /// 0-100 while downloading, -1 when the stage has no measurable fraction.
    pub percent: f64,
    pub message: String,
}

/// Outcome of an install attempt.
#[derive(Debug, Clone, Serialize)]
pub struct InstallOutcome {
    pub installed: bool,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/// Parses a version string into comparable numeric components.
///
/// GitHub tags are commonly written as `v1.2.3`, `1.2.3-beta.1` or `1.2.3`.
/// Only the leading numeric run of each dot-separated component is used, so
/// `1.2.3-beta.1` compares equal to `1.2.3` rather than sorting below it — a
/// pre-release of the version you already run is not an update.
fn parse_version(raw: &str) -> Vec<u64> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    trimmed
        .split('.')
        .map(|part| {
            let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u64>().unwrap_or(0)
        })
        .collect()
}

/// Returns true when `candidate` is a strictly newer version than `current`.
fn is_newer(candidate: &str, current: &str) -> bool {
    let a = parse_version(candidate);
    let b = parse_version(current);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let len = a.len().max(b.len());
    for i in 0..len {
        // Missing components count as 0, so "1.2" == "1.2.0".
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// GitHub release lookup
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(concat!("GCodex/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Could not create HTTP client: {e}"))
}

/// Asks GitHub for the newest release. Returns `Ok(None)` when the repo has no
/// published releases yet, and `Err` for network/parse failures.
fn fetch_latest_release() -> Result<Option<UpdateInfo>, String> {
    let url = format!(
        "https://api.github.com/repos/{RELEASE_OWNER}/{RELEASE_REPO}/releases/latest"
    );

    let client = http_client()?;
    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|e| format!("Update check failed: {e}"))?;

    // 404 means "no releases published yet" — not an error worth surfacing.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "GitHub returned HTTP {} for the release lookup",
            response.status()
        ));
    }

    // `Response::json()` requires reqwest's `json` feature, which we do not
    // enable (it would pull in another serde_json linkage). Reading the body as
    // text and parsing it ourselves keeps the dependency surface minimal.
    let body = response
        .text()
        .map_err(|e| format!("Could not read the GitHub release payload: {e}"))?;
    let release: GithubRelease = serde_json::from_str(&body)
        .map_err(|e| format!("Could not parse the GitHub release payload: {e}"))?;

    let rpm_asset = release
        .assets
        .iter()
        .find(|a| a.name.to_ascii_lowercase().ends_with(".rpm"));

    Ok(Some(UpdateInfo {
        version: release.tag_name.trim_start_matches(['v', 'V']).to_string(),
        title: release
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| release.tag_name.clone()),
        notes: release.body.unwrap_or_default(),
        html_url: release.html_url,
        rpm_url: rpm_asset.map(|a| a.browser_download_url.clone()),
        rpm_size: rpm_asset.map(|a| a.size),
    }))
}

/// Checks GitHub and returns the update when one is newer than the running app.
pub fn check_for_update() -> Result<Option<UpdateInfo>, String> {
    let current = current_version();
    match fetch_latest_release()? {
        Some(info) if is_newer(&info.version, &current) => Ok(Some(info)),
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Download & install
// ---------------------------------------------------------------------------

/// Directory the RPM is staged in before installation.
fn staging_dir() -> PathBuf {
    std::env::temp_dir().join("gcodex-update")
}

/// Downloads the RPM to the staging directory and returns its path.
fn download_rpm<F>(url: &str, total_size: Option<u64>, mut on_progress: F) -> Result<PathBuf, String>
where
    F: FnMut(f64, String),
{
    let dir = staging_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    // Keep the upstream filename when we can, so the file is recognisable in
    // /tmp if the user wants to inspect it.
    let file_name = url
        .rsplit('/')
        .next()
        .filter(|n| n.to_ascii_lowercase().ends_with(".rpm"))
        .unwrap_or("gcodex.rpm")
        .to_string();
    let dest = dir.join(&file_name);

    let client = http_client()?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("Download failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with HTTP {}",
            response.status()
        ));
    }

    let total = total_size.or_else(|| response.content_length());
    let mut file = std::fs::File::create(&dest)
        .map_err(|e| format!("Could not create {}: {e}", dest.display()))?;

    let mut written: u64 = 0;
    let mut buffer = [0u8; 64 * 1024];
    on_progress(0.0, "Starting download…".to_string());

    loop {
        let read = std::io::Read::read(&mut response, &mut buffer)
            .map_err(|e| format!("Download interrupted: {e}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| format!("Could not write to {}: {e}", dest.display()))?;
        written += read as u64;

        let percent = match total {
            Some(total) if total > 0 => (written as f64 / total as f64 * 100.0).min(100.0),
            _ => -1.0,
        };
        on_progress(percent, "Downloading update…".to_string());
    }

    file.flush()
        .map_err(|e| format!("Could not flush {}: {e}", dest.display()))?;
    drop(file);

    if written == 0 {
        return Err("Downloaded file was empty".to_string());
    }

    Ok(dest)
}

/// Installs a staged RPM with `pkexec dnf upgrade -y <path>`.
///
/// `pkexec` raises Fedora's standard authentication dialog so the user can
/// authorise the upgrade. Returns the exit status so the caller can decide
/// whether the app should be relaunched.
fn install_rpm(path: &Path) -> Result<bool, String> {
    let status = std::process::Command::new("pkexec")
        .arg("dnf")
        .arg("upgrade")
        .arg("-y")
        .arg(path)
        .status()
        .map_err(|e| format!("Could not run pkexec: {e}"))?;

    Ok(status.success())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Returns the version string of the running app, for the UI header.
#[tauri::command]
pub fn get_app_version() -> String {
    current_version()
}

/// Manual "check for updates" entry point used by the UI.
#[tauri::command]
pub fn check_for_update_command() -> Result<UpdateCheckResult, String> {
    let update = check_for_update()?;
    Ok(UpdateCheckResult {
        current_version: current_version(),
        update,
    })
}

/// Downloads and installs the update the frontend was told about.
///
/// The work happens on a blocking thread so the UI stays responsive while the
/// RPM downloads; progress is emitted as `update-progress` events.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    rpm_url: String,
    rpm_size: Option<u64>,
) -> Result<InstallOutcome, String> {
    let app_for_download = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let path = download_rpm(&rpm_url, rpm_size, |percent, message| {
            let _ = app_for_download.emit(
                UPDATE_PROGRESS_EVENT,
                UpdateProgress {
                    stage: "downloading".to_string(),
                    percent,
                    message,
                },
            );
        })?;

        let _ = app.emit(
            UPDATE_PROGRESS_EVENT,
            UpdateProgress {
                stage: "installing".to_string(),
                percent: -1.0,
                message: "Installing — enter your password to continue.".to_string(),
            },
        );

        match install_rpm(&path) {
            Ok(true) => {
                let _ = app.emit(
                    UPDATE_PROGRESS_EVENT,
                    UpdateProgress {
                        stage: "done".to_string(),
                        percent: 100.0,
                        message: "Update installed. Restart GCodex to finish.".to_string(),
                    },
                );
                Ok(InstallOutcome {
                    installed: true,
                    message: "Update installed. Restart GCodex to finish.".to_string(),
                })
            }
            Ok(false) => {
                let message = "Installation was cancelled or failed.".to_string();
                let _ = app.emit(
                    UPDATE_PROGRESS_EVENT,
                    UpdateProgress {
                        stage: "error".to_string(),
                        percent: -1.0,
                        message: message.clone(),
                    },
                );
                Ok(InstallOutcome {
                    installed: false,
                    message,
                })
            }
            Err(e) => {
                let _ = app.emit(
                    UPDATE_PROGRESS_EVENT,
                    UpdateProgress {
                        stage: "error".to_string(),
                        percent: -1.0,
                        message: e.clone(),
                    },
                );
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("Update task failed: {e}"))?;

    outcome
}

/// Kicks off the startup check on a background thread. Never blocks startup and
/// never propagates an error — a silent no-op is the correct outcome when the
/// machine is offline.
pub fn spawn_startup_check(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || match check_for_update() {
        Ok(Some(info)) => {
            let _ = app.emit(UPDATE_AVAILABLE_EVENT, info);
        }
        Ok(None) => {}
        Err(e) => {
            // Offline, rate-limited or behind a proxy: open as normal.
            eprintln!("[updater] startup check skipped: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_versions_are_detected() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("1.0.1", "1.0.0"));
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(is_newer("1.0.0", "0.9.9"));
    }

    #[test]
    fn same_or_older_versions_are_not_updates() {
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.0.9", "0.1.0"));
        assert!(!is_newer("1.2", "1.2.0"));
        assert!(!is_newer("", "0.1.0"));
    }

    #[test]
    fn leading_v_and_prerelease_suffixes_are_ignored() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(!is_newer("v0.1.0", "0.1.0"));
        assert!(!is_newer("1.2.3-beta.1", "1.2.3"));
        assert!(is_newer("1.2.4-beta.1", "1.2.3"));
    }
}
