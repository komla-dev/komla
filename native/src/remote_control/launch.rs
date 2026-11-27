//! What a phone can start on this host, as the desktop last copied it here: the projects it can
//! cut workspaces from and its agents' POSIX launch commands. The desktop rewrites `launch.json`
//! next to the trust file whenever it connects and something changed.

use std::fs;
use std::path::Path;

use anyhow::{bail, Context};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::automation::{inside, AutomationProject};
use crate::offline_workspace::{is_valid_branch, ManifestLaunch};

const LAUNCH_FILE_VERSION: u32 = 1;
const MAX_LAUNCH_FILE_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostLaunch {
    version: u32,
    /// The desktop's id for this host, which the phone names as the environment.
    host_id: String,
    #[serde(default)]
    default_launch_mode_id: Option<String>,
    #[serde(default)]
    projects: Vec<LaunchProject>,
    #[serde(default)]
    presets: Vec<LaunchPreset>,
    /// What Outside Agents may start here, as the desktop's agent launch rules decide for this
    /// host. Without it they may start nothing.
    #[serde(default)]
    agent_launch: Option<AgentLaunchRules>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AgentLaunchChoice {
    preset_id: String,
    #[serde(default)]
    launch_mode_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentLaunchRules {
    /// The agent and mode the user pinned for agent launches, or the agent that starts unnamed.
    #[serde(default)]
    default: Option<AgentLaunchChoice>,
    /// Every agent and mode agents may start on this host; no mode is the agent's default.
    allowed: Vec<AgentLaunchChoice>,
}

/// A project an Outside Agent may start workspaces in here.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AgentProject {
    pub(crate) id: String,
    pub(crate) name: String,
    /// The folder its worktrees go in, which its workspaces' manifests name.
    pub(crate) root: std::path::PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchProject {
    /// The `RemoteProjectSummary` the phone shows, as the desktop sends it.
    summary: Value,
    #[serde(flatten)]
    project: AutomationProject,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchPreset {
    /// The `RemoteAgentPresetSummary` the phone shows, as the desktop sends it.
    summary: Value,
    launches: Vec<PresetLaunch>,
}

/// One launch mode's commands; no `launchModeId` is the preset without a mode.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresetLaunch {
    #[serde(default)]
    launch_mode_id: Option<String>,
    prompt_command: String,
    open_command: String,
    #[serde(default)]
    continue_command: Option<String>,
}

fn summary_id(summary: &Value) -> &str {
    summary["id"].as_str().unwrap_or_default()
}

impl HostLaunch {
    /// A missing file offers nothing; a malformed one is an error the caller reports.
    pub(crate) fn load(path: &Path) -> anyhow::Result<Self> {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default())
            }
            Err(error) => return Err(error).context("could not read the launch options"),
        };
        if metadata.len() > MAX_LAUNCH_FILE_BYTES {
            bail!("the launch options on this host are too large");
        }
        Self::parse(&fs::read(path).context("could not read the launch options")?)
    }

    pub(crate) fn parse(bytes: &[u8]) -> anyhow::Result<Self> {
        let launch: Self = serde_json::from_slice(bytes)
            .context("the launch options on this host are malformed")?;
        if launch.version != LAUNCH_FILE_VERSION {
            bail!(
                "launch options version {} is not supported; update Komla",
                launch.version
            );
        }
        Ok(launch)
    }

    pub(crate) fn host_id(&self) -> &str {
        &self.host_id
    }

    pub(crate) fn project(&self, base: &Path, id: &str) -> Option<&AutomationProject> {
        self.projects
            .iter()
            .find(|entry| summary_id(&entry.summary) == id && entry.usable(base))
            .map(|entry| &entry.project)
    }

    /// The preset with `id`, or the first one when the phone names none.
    pub(crate) fn preset(&self, id: Option<&str>) -> Option<&LaunchPreset> {
        let mut presets = self
            .presets
            .iter()
            .filter(|preset| !preset.launches.is_empty());
        match id {
            Some(id) => presets.find(|preset| summary_id(&preset.summary) == id),
            None => presets.next(),
        }
    }

    /// Of `ids`, the projects set up here, as an Outside Agent sees them.
    pub(crate) fn agent_projects(&self, base: &Path, ids: &[String]) -> Vec<AgentProject> {
        // Workspaces name their project only by the folder they were cut in, which the desktop
        // derives from the project's name. A token must not see another project's through it.
        let shares_root = |root: &Path| {
            self.projects
                .iter()
                .filter(|entry| entry.project.remote_project_root == root)
                .count()
                > 1
        };
        self.projects
            .iter()
            .filter(|entry| {
                entry.usable(base)
                    && ids.iter().any(|id| id == summary_id(&entry.summary))
                    && !shares_root(&entry.project.remote_project_root)
            })
            .map(|entry| AgentProject {
                id: summary_id(&entry.summary).to_owned(),
                name: entry.summary["name"]
                    .as_str()
                    .or(entry.project.project_name.as_deref())
                    .unwrap_or_default()
                    .to_owned(),
                root: entry.project.remote_project_root.clone(),
            })
            .collect()
    }

    /// The agent's and mode's names, as an Outside Agent is told what it started.
    pub(crate) fn names(
        &self,
        preset_id: &str,
        launch_mode_id: Option<&str>,
    ) -> (String, Option<String>) {
        let preset = self
            .presets
            .iter()
            .find(|preset| summary_id(&preset.summary) == preset_id);
        let agent = preset.map_or(preset_id, LaunchPreset::name).to_owned();
        let mode = launch_mode_id.map(|id| {
            preset
                .and_then(|preset| preset.summary["launchModes"].as_array())
                .and_then(|modes| modes.iter().find(|mode| mode["id"] == id))
                .and_then(|mode| mode["name"].as_str())
                .unwrap_or(id)
                .to_owned()
        });
        (agent, mode)
    }

    /// The agent and mode an Outside Agent asked for, by name or id, as ids, when agents may
    /// start them here. Unnamed, they are the ones the user pinned for agent launches.
    pub(crate) fn agent_launch(
        &self,
        agent: Option<&str>,
        mode: Option<&str>,
    ) -> Result<(String, Option<String>), String> {
        let Some(rules) = &self.agent_launch else {
            return Err("No agent may start on this host for you yet. Komla on the user's computer shares that when it next connects.".to_owned());
        };
        let startable: Vec<&LaunchPreset> = self
            .presets
            .iter()
            .filter(|preset| {
                !preset.launches.is_empty()
                    && rules
                        .allowed
                        .iter()
                        .any(|choice| choice.preset_id == summary_id(&preset.summary))
            })
            .collect();
        let names = || {
            startable
                .iter()
                .map(|preset| preset.name())
                .collect::<Vec<_>>()
                .join(", ")
        };
        let preset = match agent {
            Some(agent) => startable
                .iter()
                .find(|preset| {
                    summary_id(&preset.summary) == agent
                        || preset.name().eq_ignore_ascii_case(agent)
                })
                .ok_or_else(|| {
                    format!(
                        "No agent named \"{agent}\" starts on this host. Agents: {}",
                        names()
                    )
                })?,
            None => rules
                .default
                .as_ref()
                .and_then(|choice| {
                    startable
                        .iter()
                        .find(|preset| summary_id(&preset.summary) == choice.preset_id)
                })
                .or_else(|| startable.first())
                .ok_or_else(|| "No agent may start on this host for you yet.".to_owned())?,
        };
        let preset_id = summary_id(&preset.summary).to_owned();
        let modes = preset.summary["launchModes"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let mode_name = |id: &str| {
            modes
                .iter()
                .find(|entry| entry["id"] == id)
                .and_then(|entry| entry["name"].as_str())
                .unwrap_or(id)
                .to_owned()
        };
        let launch_mode_id = match mode {
            Some(mode) => Some(
                modes
                    .iter()
                    .find(|entry| {
                        entry["id"] == mode
                            || entry["name"]
                                .as_str()
                                .is_some_and(|name| name.eq_ignore_ascii_case(mode))
                    })
                    .and_then(|entry| entry["id"].as_str())
                    .ok_or_else(|| {
                        let known = modes
                            .iter()
                            .filter_map(|entry| entry["name"].as_str())
                            .collect::<Vec<_>>()
                            .join(", ");
                        format!(
                            "{} has no launch mode \"{mode}\". Its modes: {known}",
                            preset.name()
                        )
                    })?
                    .to_owned(),
            ),
            None => rules
                .default
                .as_ref()
                .filter(|choice| choice.preset_id == preset_id)
                .and_then(|choice| choice.launch_mode_id.clone()),
        };
        let choice = AgentLaunchChoice {
            preset_id: preset_id.clone(),
            launch_mode_id: launch_mode_id.clone(),
        };
        if !rules.allowed.contains(&choice) {
            return Err(match &launch_mode_id {
                Some(id) => format!(
                    "Launch mode \"{}\" of {} can't be started by agents on this host. The user can let agents start it in Komla's Settings → Agents.",
                    mode_name(id),
                    preset.name()
                ),
                None => format!("{} can't be started by agents on this host.", preset.name()),
            });
        }
        Ok((preset_id, launch_mode_id))
    }

    /// The `app:launch-options` reply: nothing to start until a project's repository is here.
    /// Projects keep the icons the desktop fitted in one frame only for a phone that takes them.
    pub(crate) fn options_frame(
        &self,
        request_id: &str,
        base: &Path,
        host_name: &str,
        project_icons: bool,
    ) -> Value {
        let projects: Vec<Value> = self
            .projects
            .iter()
            .filter(|entry| entry.usable(base))
            .map(|entry| {
                let mut summary = entry.summary.clone();
                if !project_icons {
                    if let Some(fields) = summary.as_object_mut() {
                        fields.remove("icon");
                    }
                }
                summary
            })
            .collect();
        let presets: Vec<Value> = if projects.is_empty() {
            Vec::new()
        } else {
            self.presets
                .iter()
                .filter(|preset| !preset.launches.is_empty())
                .map(|preset| preset.summary.clone())
                .collect()
        };
        let environments = if presets.is_empty() {
            json!([])
        } else {
            json!([{ "kind": "ssh", "id": self.host_id, "name": host_name }])
        };
        let mut frame = json!({
            "type": "app:launch-options",
            "requestId": request_id,
            "projects": if presets.is_empty() { Vec::new() } else { projects },
            "presets": presets,
            "environments": environments,
            "actions": [],
        });
        if let Some(mode) = &self.default_launch_mode_id {
            frame["defaultLaunchModeId"] = Value::String(mode.clone());
        }
        frame
    }
}

impl LaunchProject {
    /// Its repository is already set up on this host, inside Komla's data directory.
    fn usable(&self, base: &Path) -> bool {
        let project = &self.project;
        !summary_id(&self.summary).is_empty()
            && inside(&project.remote_repo_path, &base.join("repos"))
            && inside(&project.remote_project_root, &base.join("worktrees"))
            && [&project.base_branch, &project.default_branch]
                .into_iter()
                .flatten()
                .all(|branch| is_valid_branch(branch))
            && project.remote_repo_path.is_dir()
    }
}

impl LaunchPreset {
    pub(crate) fn name(&self) -> &str {
        self.summary["name"].as_str().unwrap_or("Agent")
    }

    /// The commands for `launch_mode_id`, else the preset's without a mode.
    pub(crate) fn launch(&self, launch_mode_id: Option<&str>) -> Option<ManifestLaunch> {
        let found = launch_mode_id
            .and_then(|mode| {
                self.launches
                    .iter()
                    .find(|launch| launch.launch_mode_id.as_deref() == Some(mode))
            })
            .or_else(|| {
                self.launches
                    .iter()
                    .find(|launch| launch.launch_mode_id.is_none())
            })?;
        if !found.prompt_command.contains("{{prompt}}") || found.open_command.trim().is_empty() {
            return None;
        }
        Some(ManifestLaunch {
            agent_name: self.name().to_owned(),
            prompt_command: found.prompt_command.clone(),
            open_command: found.open_command.clone(),
            continue_command: found
                .continue_command
                .clone()
                .filter(|command| !command.trim().is_empty()),
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn launch_json(base: &Path) -> Value {
        json!({
            "version": 1,
            "hostId": "host-1",
            "defaultLaunchModeId": "yolo",
            "projects": [
                {
                    "summary": { "id": "p-app", "name": "app", "repositoryPath": "/Users/me/app" },
                    "remoteRepoPath": base.join("repos/app/repo.git"),
                    "remoteProjectRoot": base.join("worktrees/app"),
                    "gitUrl": "git@example.com:app.git",
                    "projectName": "app",
                    "baseBranch": "main",
                    "branchPrefix": "tord/",
                },
                {
                    "summary": { "id": "p-other", "name": "other", "repositoryPath": "/Users/me/other" },
                    "remoteRepoPath": base.join("repos/other/repo.git"),
                    "remoteProjectRoot": base.join("worktrees/other"),
                    "gitUrl": "git@example.com:other.git",
                },
                {
                    "summary": { "id": "p-outside", "name": "outside", "repositoryPath": "/x" },
                    "remoteRepoPath": "/etc",
                    "remoteProjectRoot": base.join("worktrees/outside"),
                    "gitUrl": "git@example.com:x.git",
                },
            ],
            "presets": [
                {
                    "summary": {
                        "id": "claude",
                        "name": "Claude Code",
                        "launchModes": [{ "id": "yolo", "name": "YOLO" }],
                    },
                    "launches": [
                        {
                            "promptCommand": "claude {{prompt}}",
                            "openCommand": "claude",
                            "continueCommand": "claude --resume",
                        },
                        {
                            "launchModeId": "yolo",
                            "promptCommand": "claude --yolo {{prompt}}",
                            "openCommand": "claude --yolo",
                            "continueCommand": "claude --resume --yolo",
                        },
                    ],
                },
                {
                    "summary": { "id": "shell-only", "name": "Shell only", "launchModes": [] },
                    "launches": [],
                },
            ],
        })
    }

    #[test]
    fn offers_projects_set_up_on_this_host_and_agents_that_start_here() {
        let base = tempfile::tempdir().unwrap();
        fs::create_dir_all(base.path().join("repos/app/repo.git")).unwrap();
        let launch = HostLaunch::parse(launch_json(base.path()).to_string().as_bytes()).unwrap();

        let frame = launch.options_frame("r1", base.path(), "devbox", false);

        assert_eq!(frame["projects"][0]["id"], "p-app");
        assert_eq!(frame["projects"].as_array().unwrap().len(), 1);
        assert_eq!(frame["presets"][0]["id"], "claude");
        assert_eq!(frame["presets"].as_array().unwrap().len(), 1);
        assert_eq!(
            frame["environments"],
            json!([{ "kind": "ssh", "id": "host-1", "name": "devbox" }])
        );
        assert_eq!(frame["defaultLaunchModeId"], "yolo");
        assert!(launch.project(base.path(), "p-other").is_none());
        assert!(launch.project(base.path(), "p-outside").is_none());
    }

    #[test]
    fn sends_projects_icons_only_to_a_phone_that_agreed_to_them() {
        let base = tempfile::tempdir().unwrap();
        fs::create_dir_all(base.path().join("repos/app/repo.git")).unwrap();
        let mut file = launch_json(base.path());
        file["projects"][0]["summary"]["icon"] = json!("data:image/png;base64,iVBORw0KGgo=");
        let launch = HostLaunch::parse(file.to_string().as_bytes()).unwrap();

        let agreed = launch.options_frame("r1", base.path(), "devbox", true);
        let older = launch.options_frame("r1", base.path(), "devbox", false);

        assert_eq!(
            agreed["projects"][0]["icon"],
            "data:image/png;base64,iVBORw0KGgo="
        );
        assert!(older["projects"][0].get("icon").is_none());
    }

    #[test]
    fn offers_nothing_without_a_project_here_or_a_file() {
        let base = tempfile::tempdir().unwrap();
        let launch = HostLaunch::parse(launch_json(base.path()).to_string().as_bytes()).unwrap();
        let missing = HostLaunch::load(&base.path().join("launch.json")).unwrap();

        for launch in [launch, missing] {
            let frame = launch.options_frame("r1", base.path(), "devbox", false);
            assert_eq!(frame["projects"], json!([]));
            assert_eq!(frame["presets"], json!([]));
            assert_eq!(frame["environments"], json!([]));
        }
        assert!(HostLaunch::parse(br#"{"version":2,"hostId":"h"}"#).is_err());
    }

    fn with_agent_launch(base: &Path, agent_launch: Value) -> HostLaunch {
        let mut file = launch_json(base);
        file["agentLaunch"] = agent_launch;
        HostLaunch::parse(file.to_string().as_bytes()).unwrap()
    }

    #[test]
    fn lets_an_outside_agent_start_only_what_agents_may_start_here() {
        let base = tempfile::tempdir().unwrap();
        let launch = with_agent_launch(
            base.path(),
            json!({
                "default": { "presetId": "claude" },
                "allowed": [{ "presetId": "claude" }],
            }),
        );

        // Names or ids, in any case; no agent is the default one, in the default mode.
        assert_eq!(
            launch.agent_launch(None, None),
            Ok(("claude".to_owned(), None))
        );
        assert_eq!(
            launch.agent_launch(Some("claude code"), None),
            Ok(("claude".to_owned(), None))
        );
        let refused = launch
            .agent_launch(Some("Claude Code"), Some("yolo"))
            .unwrap_err();
        assert!(refused.contains("YOLO"), "{refused}");
        assert!(launch
            .agent_launch(Some("Codex"), None)
            .unwrap_err()
            .contains("Claude Code"));
        assert!(launch
            .agent_launch(None, Some("turbo"))
            .unwrap_err()
            .contains("YOLO"));
    }

    #[test]
    fn starts_the_pinned_mode_when_the_agent_names_none() {
        let base = tempfile::tempdir().unwrap();
        let launch = with_agent_launch(
            base.path(),
            json!({
                "default": { "presetId": "claude", "launchModeId": "yolo" },
                "allowed": [{ "presetId": "claude", "launchModeId": "yolo" }],
            }),
        );

        assert_eq!(
            launch.agent_launch(None, None),
            Ok(("claude".to_owned(), Some("yolo".to_owned())))
        );
        assert_eq!(
            launch.agent_launch(Some("claude"), Some("YOLO")),
            Ok(("claude".to_owned(), Some("yolo".to_owned())))
        );
    }

    #[test]
    fn lets_an_outside_agent_start_nothing_without_the_desktops_say() {
        let base = tempfile::tempdir().unwrap();
        let launch = HostLaunch::parse(launch_json(base.path()).to_string().as_bytes()).unwrap();

        assert!(launch.agent_launch(None, None).is_err());
    }

    #[test]
    fn picks_the_launch_mode_the_phone_asked_for() {
        let base = tempfile::tempdir().unwrap();
        let launch = HostLaunch::parse(launch_json(base.path()).to_string().as_bytes()).unwrap();
        let preset = launch.preset(None).unwrap();

        assert_eq!(preset.name(), "Claude Code");
        assert_eq!(
            preset.launch(Some("yolo")).unwrap().open_command,
            "claude --yolo"
        );
        assert_eq!(preset.launch(Some("gone")).unwrap().open_command, "claude");
        assert_eq!(
            preset.launch(None).unwrap().continue_command.as_deref(),
            Some("claude --resume")
        );
        assert!(launch.preset(Some("shell-only")).is_none());
    }
}
