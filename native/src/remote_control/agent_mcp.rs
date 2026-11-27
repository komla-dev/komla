//! `/remote/mcp` on this host: the MCP route Outside Agents call with an Agent Token (ADR 0013),
//! so one keeps starting workspaces here while the desktop sleeps.
//!
//! It is the desktop route's twin: the same four tools (`agent_mcp_tools.json`, which the desktop's
//! tests hold to its own list), the same refusals, and only the token's projects. The desktop
//! decides everything this trusts: the token hashes in `trust.json`, under the phones' lease, and
//! the agents and modes agents may start here in `launch.json`. Nothing here opens, reads or types
//! into a terminal.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::launch::{AgentProject, HostLaunch};
use super::trust::{AgentToken, Trust};
use super::workspace_control::CreateRequest;

pub(crate) const MCP_PATH: &str = "/remote/mcp";
/// A prompt of 64K characters, four bytes each, with room for the rest of the request.
pub(crate) const MAX_BODY_BYTES: usize = 320 * 1024;
const TOOLS: &str = include_str!("agent_mcp_tools.json");
/// Newest first; a client asking for another gets the newest.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_PROMPT_CHARS: usize = 64 * 1024;
const MAX_NAME_CHARS: usize = 256;
const MAX_DESCRIPTION_CHARS: usize = 1024;

pub(crate) struct HttpRequest {
    pub(crate) method: String,
    /// Names in lowercase.
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
}

impl HttpRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

#[derive(Debug)]
pub(crate) struct HttpResponse {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(&'static str, String)>,
    /// JSON, or empty for 202.
    pub(crate) body: String,
}

/// A workspace on this host, as the phone's list summarizes it, with the folder it was cut in.
pub(crate) struct AgentWorkspace {
    pub(crate) summary: Value,
    pub(crate) project_root: Option<PathBuf>,
}

/// What the route reads and changes on this host.
pub(crate) trait AgentHost {
    fn trust(&self) -> Trust;
    fn launch(&self) -> anyhow::Result<HostLaunch>;
    fn base(&self) -> &Path;
    fn workspaces(&self) -> Vec<AgentWorkspace>;
    /// Cuts the workspace and starts its agent, returning its id.
    fn create(&self, launch: &HostLaunch, request: &CreateRequest) -> anyhow::Result<String>;
}

/// Answers one request to `/remote/mcp`.
pub(crate) fn handle(request: &HttpRequest, host: &dyn AgentHost, now_ms: u64) -> HttpResponse {
    // Browsers send these for pages; MCP clients don't. A page on the tailnet must not use a token
    // the browser can't hold anyway, nor learn whether Komla answers.
    let fetch_site = request.header("sec-fetch-site");
    if request.header("origin").is_some() || fetch_site.is_some_and(|site| site != "none") {
        return error_response(403, "Browser requests are not accepted.");
    }
    let bearer = request.header("authorization").and_then(|value| {
        let (scheme, token) = value.trim().split_once(char::is_whitespace)?;
        // An auth scheme's name is case-insensitive (RFC 9110).
        let token = token.trim();
        (scheme.eq_ignore_ascii_case("bearer") && !token.contains(char::is_whitespace))
            .then_some(token)
    });
    let trust = host.trust();
    let Some(token) = bearer.and_then(|bearer| trust.agent_token(bearer, now_ms)) else {
        let mut response = error_response(
            401,
            if bearer.is_some() {
                "This agent token is not valid here: it expired or was revoked, or Komla on the user's computer hasn't shared it with this host yet."
            } else {
                "Send an agent token as \"Authorization: Bearer <token>\". Make one in Komla under Settings › Remote › Agent access."
            },
        );
        response.headers.push((
            "www-authenticate",
            if bearer.is_some() {
                r#"Bearer realm="komla", error="invalid_token""#
            } else {
                r#"Bearer realm="komla""#
            }
            .to_owned(),
        ));
        return response;
    };
    if request.method != "POST" {
        // The endpoint is stateless: there is no stream to open and no session to end.
        let mut response = error_response(405, "Method not allowed.");
        response.headers.push(("allow", "POST".to_owned()));
        return response;
    }
    let Ok(message) = serde_json::from_slice::<Value>(&request.body) else {
        return rpc_response(&Value::Null, Err(rpc_error(-32700, "Parse error")));
    };
    let Some(fields) = message.as_object() else {
        return rpc_response(&Value::Null, Err(rpc_error(-32600, "Invalid Request")));
    };
    let Some(method) = fields.get("method").and_then(Value::as_str) else {
        // A response or something else no server takes: nothing to answer.
        return accepted();
    };
    let Some(id) = fields.get("id") else {
        // A notification, such as notifications/initialized.
        return accepted();
    };
    let params = fields.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Ok(initialize(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => call_tool(&params, token, host),
        _ => Err(rpc_error(-32601, "Method not found")),
    };
    rpc_response(id, result)
}

fn tools() -> Value {
    serde_json::from_str(TOOLS).expect("agent_mcp_tools.json is valid JSON")
}

fn initialize(params: &Value) -> Value {
    let asked = params["protocolVersion"].as_str();
    let version = PROTOCOL_VERSIONS
        .into_iter()
        .find(|version| Some(*version) == asked)
        .unwrap_or(PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "komla", "version": env!("CARGO_PKG_VERSION") },
    })
}

fn call_tool(params: &Value, token: &AgentToken, host: &dyn AgentHost) -> Result<Value, Value> {
    let name = params["name"].as_str().unwrap_or_default();
    let empty = Map::new();
    let arguments = match &params["arguments"] {
        Value::Null => &empty,
        Value::Object(arguments) => arguments,
        _ => {
            return Err(rpc_error(
                -32602,
                "Invalid params: arguments must be an object",
            ))
        }
    };
    let tool = Tool::parse(name, arguments).map_err(|message| {
        rpc_error(
            -32602,
            &format!("Invalid params for tool {name}: {message}"),
        )
    })?;
    Ok(match run(tool, token, host) {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": pretty(&value) }],
            "structuredContent": { "value": value },
        }),
        Err(message) => json!({
            "content": [{ "type": "text", "text": format!("Error: {message}") }],
            "isError": true,
        }),
    })
}

enum Tool {
    ListProjects,
    ListWorkspaces {
        include_trashed: bool,
    },
    Launch {
        project: String,
        prompt: String,
        name: Option<String>,
        description: Option<String>,
        branch: Option<String>,
        agent: Option<String>,
        mode: Option<String>,
    },
    Status {
        workspace_id: String,
    },
}

impl Tool {
    fn parse(name: &str, arguments: &Map<String, Value>) -> Result<Self, String> {
        let text = |key: &str, max_chars: usize| -> Result<Option<String>, String> {
            match arguments.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(text))
                    if !text.is_empty() && text.chars().count() <= max_chars =>
                {
                    Ok(Some(text.clone()))
                }
                Some(_) => Err(format!(
                    "{key} must be a string of 1 to {max_chars} characters"
                )),
            }
        };
        let required = |key: &str, max_chars: usize| {
            text(key, max_chars)?.ok_or_else(|| format!("{key} is required"))
        };
        match name {
            "list_projects" => Ok(Self::ListProjects),
            "list_workspaces" => Ok(Self::ListWorkspaces {
                include_trashed: match arguments.get("includeTrashed") {
                    None | Some(Value::Null) => false,
                    Some(Value::Bool(include)) => *include,
                    Some(_) => return Err("includeTrashed must be a boolean".to_owned()),
                },
            }),
            "launch_workspace" => Ok(Self::Launch {
                project: required("project", MAX_NAME_CHARS)?,
                prompt: required("prompt", MAX_PROMPT_CHARS)?,
                name: text("name", MAX_NAME_CHARS)?,
                description: text("description", MAX_DESCRIPTION_CHARS)?,
                branch: text("branch", MAX_NAME_CHARS)?,
                agent: text("agent", MAX_NAME_CHARS)?,
                mode: text("mode", MAX_NAME_CHARS)?,
            }),
            "workspace_status" => Ok(Self::Status {
                workspace_id: required("workspaceId", MAX_NAME_CHARS)?,
            }),
            _ => Err(format!("unknown tool {name:?}")),
        }
    }
}

/// A tool's result, or a refusal written for the caller.
fn run(tool: Tool, token: &AgentToken, host: &dyn AgentHost) -> Result<Value, String> {
    let launch = host.launch().map_err(|cause| {
        eprintln!("agent MCP: launch options unreadable: {cause:#}");
        "Komla on this host can't read what it may start. Open Komla on the user's computer so it can share that again.".to_owned()
    })?;
    let projects = launch.agent_projects(host.base(), &token.project_ids);
    match tool {
        Tool::ListProjects => Ok(json!({
            "projects": projects
                .iter()
                .map(|project| json!({ "id": project.id, "name": project.name }))
                .collect::<Vec<_>>(),
        })),
        Tool::ListWorkspaces { include_trashed } => Ok(Value::Array(
            workspaces_in(host, &projects)
                .into_iter()
                .filter(|workspace| include_trashed || workspace["trashed"] != true)
                .collect(),
        )),
        Tool::Status { workspace_id } => workspaces_in(host, &projects)
            .into_iter()
            .find(|workspace| workspace["id"] == workspace_id.as_str())
            .ok_or_else(|| format!("No workspace in your projects has the id {workspace_id}.")),
        Tool::Launch {
            project,
            prompt,
            name,
            description,
            branch,
            agent,
            mode,
        } => {
            let Some(project) = projects.iter().find(|candidate| {
                candidate.id == project || candidate.name.eq_ignore_ascii_case(&project)
            }) else {
                let names = projects
                    .iter()
                    .map(|project| project.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(format!(
                    "Project \"{project}\" was not found on this host.\nYour projects: {names}"
                ));
            };
            let (preset_id, launch_mode_id) =
                launch.agent_launch(agent.as_deref(), mode.as_deref())?;
            let request = CreateRequest {
                project_id: project.id.clone(),
                preset_id: Some(preset_id.clone()),
                launch_mode_id: launch_mode_id.clone(),
                name,
                branch,
                prompt: Some(prompt),
                description,
            };
            let workspace_id = host.create(&launch, &request).map_err(|cause| {
                // Git's and the shell's words can name this host's paths; they stay in its log.
                eprintln!("agent MCP: could not start a workspace: {cause:#}");
                "Komla could not start the workspace on this host.".to_owned()
            })?;
            let (agent, mode) = launch.names(&preset_id, launch_mode_id.as_deref());
            let mut result =
                json!({ "state": "started", "workspaceId": workspace_id, "agent": agent });
            if let Some(branch) = workspaces_in(host, &projects)
                .iter()
                .find(|workspace| workspace["id"] == workspace_id.as_str())
                .and_then(|workspace| workspace["branch"].as_str())
            {
                result["branch"] = Value::String(branch.to_owned());
            }
            if let Some(mode) = mode {
                result["mode"] = Value::String(mode);
            }
            Ok(result)
        }
    }
}

/// The workspaces cut in the token's projects, as the desktop route lists them.
fn workspaces_in(host: &dyn AgentHost, projects: &[AgentProject]) -> Vec<Value> {
    host.workspaces()
        .into_iter()
        .filter_map(|workspace| {
            let project = projects.iter().find(|project| {
                workspace.project_root.as_deref() == Some(project.root.as_path())
            })?;
            Some(agent_summary(&workspace.summary, project))
        })
        .collect()
}

/// The desktop route's summary: no paths, no terminals.
fn agent_summary(summary: &Value, project: &AgentProject) -> Value {
    let mut result = json!({
        "id": summary["id"],
        "name": summary["name"],
        "project": project.name,
        "environment": "ssh",
        "agentActive": summary["agentActive"] == true,
    });
    if let Some(branch) = summary["branchName"].as_str() {
        result["branch"] = Value::String(branch.to_owned());
    }
    if let Some(kind) = summary["attention"]["kind"].as_str() {
        result["attention"] = Value::String(kind.to_owned());
    }
    if let Some(tag) = summary["tag"]["name"].as_str() {
        result["tag"] = Value::String(tag.to_owned());
    }
    if summary["status"] == "trashed" {
        result["trashed"] = Value::Bool(true);
    }
    result
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

fn rpc_error(code: i64, message: &str) -> Value {
    json!({ "code": code, "message": message })
}

fn rpc_response(id: &Value, result: Result<Value, Value>) -> HttpResponse {
    let body = match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    };
    json_response(200, &body)
}

fn accepted() -> HttpResponse {
    HttpResponse {
        status: 202,
        headers: Vec::new(),
        body: String::new(),
    }
}

fn error_response(status: u16, message: &str) -> HttpResponse {
    json_response(status, &json!({ "error": message }))
}

fn json_response(status: u16, body: &Value) -> HttpResponse {
    HttpResponse {
        status,
        headers: vec![("content-type", "application/json".to_owned())],
        body: body.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::fs;

    use super::*;
    use crate::remote_control::launch::tests::launch_json;
    use crate::remote_control::trust::hash_agent_token;

    const TOKEN: &str = "komla_agent_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    struct FakeHost {
        base: tempfile::TempDir,
        trust: Trust,
        launch: Value,
        workspaces: Vec<(Value, PathBuf)>,
        created: RefCell<Vec<String>>,
        fail_create: bool,
    }

    impl FakeHost {
        fn new() -> Self {
            let base = tempfile::tempdir().unwrap();
            fs::create_dir_all(base.path().join("repos/app/repo.git")).unwrap();
            let mut launch = launch_json(base.path());
            launch["agentLaunch"] = json!({
                "default": { "presetId": "claude" },
                "allowed": [{ "presetId": "claude" }],
            });
            let root = base.path().join("worktrees/app");
            let trust = Trust::parse(
                json!({
                    "version": 1,
                    "expiresAt": u64::MAX,
                    "devices": [],
                    "agentTokens": [{
                        "id": "tok-1",
                        "tokenHash": hash_agent_token(TOKEN),
                        "projectIds": ["p-app", "p-other"],
                        "expiresAt": null,
                    }],
                })
                .to_string()
                .as_bytes(),
            )
            .unwrap();
            Self {
                trust,
                launch,
                workspaces: vec![
                    (
                        json!({
                            "id": "ws-1",
                            "name": "Login fix",
                            "workingDirectory": "/home/u/.komla/worktrees/app/fix-login",
                            "projectName": "app",
                            "branchName": "tord/fix-login",
                            "status": "active",
                            "agentActive": true,
                            "attention": { "kind": "input-required", "terminalId": "t" },
                            "tag": { "name": "Review", "tone": "info" },
                            "terminals": [],
                        }),
                        root.clone(),
                    ),
                    (
                        json!({ "id": "ws-old", "name": "Old", "status": "trashed", "terminals": [] }),
                        root,
                    ),
                    (
                        json!({ "id": "ws-elsewhere", "name": "Not yours", "status": "active", "terminals": [] }),
                        base.path().join("worktrees/secret"),
                    ),
                ],
                base,
                created: RefCell::new(Vec::new()),
                fail_create: false,
            }
        }
    }

    impl AgentHost for FakeHost {
        fn trust(&self) -> Trust {
            self.trust.clone()
        }
        fn launch(&self) -> anyhow::Result<HostLaunch> {
            HostLaunch::parse(self.launch.to_string().as_bytes())
        }
        fn base(&self) -> &Path {
            self.base.path()
        }
        fn workspaces(&self) -> Vec<AgentWorkspace> {
            self.workspaces
                .iter()
                .map(|(summary, root)| AgentWorkspace {
                    summary: summary.clone(),
                    project_root: Some(root.clone()),
                })
                .collect()
        }
        fn create(&self, _: &HostLaunch, request: &CreateRequest) -> anyhow::Result<String> {
            if self.fail_create {
                anyhow::bail!("fatal: could not create work tree dir '/home/u/.komla/x'");
            }
            self.created.borrow_mut().push(format!(
                "{}|{:?}|{:?}|{:?}|{:?}",
                request.project_id,
                request.preset_id,
                request.launch_mode_id,
                request.prompt,
                request.description
            ));
            Ok("ws-1".to_owned())
        }
    }

    fn post(body: Value) -> HttpRequest {
        HttpRequest {
            method: "POST".to_owned(),
            headers: vec![
                ("authorization".to_owned(), format!("Bearer {TOKEN}")),
                ("content-type".to_owned(), "application/json".to_owned()),
            ],
            body: body.to_string().into_bytes(),
        }
    }

    fn rpc(host: &FakeHost, method: &str, params: Value) -> Value {
        let response = handle(
            &post(json!({ "jsonrpc": "2.0", "id": 7, "method": method, "params": params })),
            host,
            0,
        );
        assert_eq!(response.status, 200, "{}", response.body);
        let body: Value = serde_json::from_str(&response.body).unwrap();
        assert_eq!(body["id"], 7);
        body
    }

    fn call(host: &FakeHost, name: &str, arguments: Value) -> Value {
        rpc(
            host,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )["result"]
            .clone()
    }

    #[test]
    fn answers_initialize_and_lists_the_desktops_tools() {
        let host = FakeHost::new();

        let init = rpc(
            &host,
            "initialize",
            json!({ "protocolVersion": "2025-03-26" }),
        );
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(init["result"]["serverInfo"]["name"], "komla");
        let newest = rpc(
            &host,
            "initialize",
            json!({ "protocolVersion": "1999-01-01" }),
        );
        assert_eq!(newest["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);

        let names: Vec<_> = rpc(&host, "tools/list", json!({}))["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            names,
            [
                "list_projects",
                "list_workspaces",
                "launch_workspace",
                "workspace_status"
            ]
        );
        let notification = handle(
            &post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })),
            &host,
            0,
        );
        assert_eq!(notification.status, 202);
    }

    #[test]
    fn lists_only_the_tokens_projects_that_are_set_up_here() {
        let host = FakeHost::new();

        let result = call(&host, "list_projects", json!({}));

        // p-other is the token's too, but its repository isn't on this host.
        assert_eq!(
            result["structuredContent"]["value"],
            json!({ "projects": [{ "id": "p-app", "name": "app" }] })
        );
    }

    #[test]
    fn lists_workspaces_in_the_tokens_projects_without_paths() {
        let host = FakeHost::new();

        let listed =
            call(&host, "list_workspaces", json!({}))["structuredContent"]["value"].clone();
        assert_eq!(
            listed,
            json!([{
                "id": "ws-1",
                "name": "Login fix",
                "project": "app",
                "branch": "tord/fix-login",
                "environment": "ssh",
                "agentActive": true,
                "attention": "input-required",
                "tag": "Review",
            }])
        );
        let with_trash = call(&host, "list_workspaces", json!({ "includeTrashed": true }));
        assert_eq!(
            with_trash["structuredContent"]["value"][1],
            json!({ "id": "ws-old", "name": "Old", "project": "app", "environment": "ssh", "agentActive": false, "trashed": true })
        );
        let status = call(
            &host,
            "workspace_status",
            json!({ "workspaceId": "ws-old" }),
        );
        assert_eq!(status["structuredContent"]["value"]["trashed"], true);
        let hidden = call(
            &host,
            "workspace_status",
            json!({ "workspaceId": "ws-elsewhere" }),
        );
        assert_eq!(hidden["isError"], true);
    }

    #[test]
    fn keeps_out_a_project_whose_folder_another_project_shares() {
        let mut host = FakeHost::new();
        // Another project of the same name, which the token wasn't given, cuts its workspaces in
        // the same folder.
        let twin = json!({
            "summary": { "id": "p-twin", "name": "App", "repositoryPath": "/Users/me/App" },
            "remoteRepoPath": host.base.path().join("repos/app/repo.git"),
            "remoteProjectRoot": host.base.path().join("worktrees/app"),
            "gitUrl": "git@example.com:twin.git",
        });
        host.launch["projects"].as_array_mut().unwrap().push(twin);

        let projects = call(&host, "list_projects", json!({}));
        let workspaces = call(&host, "list_workspaces", json!({ "includeTrashed": true }));

        assert_eq!(
            projects["structuredContent"]["value"],
            json!({ "projects": [] })
        );
        assert_eq!(workspaces["structuredContent"]["value"], json!([]));
    }

    #[test]
    fn starts_a_workspace_with_what_agents_may_start_here() {
        let host = FakeHost::new();

        let started = call(
            &host,
            "launch_workspace",
            json!({ "project": "APP", "prompt": "Fix the login", "description": "One line" }),
        );

        assert_eq!(
            started["structuredContent"]["value"],
            json!({ "state": "started", "workspaceId": "ws-1", "branch": "tord/fix-login", "agent": "Claude Code" })
        );
        assert_eq!(
            host.created.borrow().as_slice(),
            [r#"p-app|Some("claude")|None|Some("Fix the login")|Some("One line")"#]
        );
        let refused = call(
            &host,
            "launch_workspace",
            json!({ "project": "app", "prompt": "x", "mode": "YOLO" }),
        );
        assert_eq!(refused["isError"], true);
        assert!(refused["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("YOLO"));
        let elsewhere = call(
            &host,
            "launch_workspace",
            json!({ "project": "other", "prompt": "x" }),
        );
        assert!(elsewhere["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Your projects: app"));
        assert_eq!(host.created.borrow().len(), 1);
    }

    #[test]
    fn keeps_a_failed_starts_details_on_this_host() {
        let mut host = FakeHost::new();
        host.fail_create = true;

        let failed = call(
            &host,
            "launch_workspace",
            json!({ "project": "app", "prompt": "x" }),
        );

        assert_eq!(failed["isError"], true);
        let text = failed["content"][0]["text"].as_str().unwrap();
        assert!(!text.contains("/home/u"), "{text}");
    }

    #[test]
    fn refuses_bad_arguments_as_invalid_params() {
        let host = FakeHost::new();

        for (name, arguments) in [
            ("launch_workspace", json!({ "project": "app" })),
            (
                "launch_workspace",
                json!({ "project": "app", "prompt": "" }),
            ),
            (
                "launch_workspace",
                json!({ "project": "app", "prompt": "x".repeat(MAX_PROMPT_CHARS + 1) }),
            ),
            ("list_workspaces", json!({ "includeTrashed": "yes" })),
            ("open_terminal", json!({})),
        ] {
            let body = rpc(
                &host,
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            );
            assert_eq!(body["error"]["code"], -32602, "{name}: {body}");
        }
        assert_eq!(
            rpc(&host, "resources/list", json!({}))["error"]["code"],
            -32601
        );
        assert!(host.created.borrow().is_empty());
    }

    #[test]
    fn answers_401_without_a_token_or_with_one_it_was_not_given() {
        let host = FakeHost::new();
        let mut missing = post(json!({}));
        missing.headers.retain(|(name, _)| name != "authorization");
        let mut unknown = post(json!({}));
        unknown.headers[0].1 = format!("Bearer komla_agent_{}", "B".repeat(43));
        let mut lowercase = post(json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }));
        lowercase.headers[0].1 = format!("bearer {TOKEN}");

        let refused = handle(&missing, &host, 0);
        assert_eq!(refused.status, 401);
        assert!(
            refused
                .headers
                .iter()
                .any(|(name, value)| *name == "www-authenticate"
                    && value == r#"Bearer realm="komla""#)
        );
        assert_eq!(handle(&unknown, &host, 0).status, 401);
        assert_eq!(handle(&lowercase, &host, 0).status, 200);
        // Once the desktop's lease runs out, no token works.
        let mut expired = FakeHost::new();
        expired.trust = Trust::parse(
            json!({ "version": 1, "expiresAt": 10, "devices": [], "agentTokens": [{
                "id": "t", "tokenHash": hash_agent_token(TOKEN), "projectIds": ["p-app"], "expiresAt": null,
            }] })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(handle(&post(json!({})), &expired, 10).status, 401);
    }

    #[test]
    fn refuses_browser_requests_even_with_a_valid_token() {
        let host = FakeHost::new();
        let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
        let mut with_origin = post(ping.clone());
        with_origin
            .headers
            .push(("origin".to_owned(), "https://evil.tail1.ts.net".to_owned()));
        let mut cross_site = post(ping.clone());
        cross_site
            .headers
            .push(("sec-fetch-site".to_owned(), "same-site".to_owned()));
        let mut typed = post(ping);
        typed
            .headers
            .push(("sec-fetch-site".to_owned(), "none".to_owned()));

        assert_eq!(handle(&with_origin, &host, 0).status, 403);
        assert_eq!(handle(&cross_site, &host, 0).status, 403);
        assert_eq!(handle(&typed, &host, 0).status, 200);
    }

    #[test]
    fn opens_no_stream() {
        let host = FakeHost::new();
        let mut get = post(json!({}));
        get.method = "GET".to_owned();

        let response = handle(&get, &host, 0);

        assert_eq!(response.status, 405);
        assert!(response
            .headers
            .iter()
            .any(|(name, value)| *name == "allow" && value == "POST"));
    }
}
