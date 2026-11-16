//! The Terminal each Claude Code session reports to, so that a session Claude moves into its
//! background daemon still reports to the Terminal that shows it.
//!
//! Claude Code can move an interactive session into its daemon mid-turn: the Terminal's `claude`
//! then only shows the daemon's session, which runs under a new session id, and reports no program
//! status (OSC 7501) to the Terminal. The daemon's sessions keep the environment of the Terminal
//! that started the daemon, whatever session they run, and the daemon runs agents of its own too,
//! so their `KOMLA_TERMINAL_ID` can name the wrong Terminal. A moved session is known by the
//! `continued-in` record Claude appends to the transcript of the session it continues, and that
//! session's own hooks named its Terminal: `komla notify` keeps each interactive session's route
//! here, and a background session takes the route of the session it continues.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hook_journal::write_atomically;
use crate::offline_workspace::is_manifest_id;

/// In Komla's data folder.
pub(crate) const DIRECTORY: &str = "claude-sessions";
/// A session that reported nothing for this long is forgotten.
const KEPT_FOR: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// The transcripts beside a background session's that may hold its `continued-in`, newest first.
/// Claude writes the record as the session moves, so the one it continues was written lately.
const SCANNED_TRANSCRIPTS: usize = 32;
/// The record is among a transcript's last lines: Claude writes it as the session moves on.
const SCANNED_TAIL_BYTES: u64 = 16 * 1024;
/// How long after first finding no route a background session is looked for again.
const SETTLES_IN: Duration = Duration::from_secs(60);

/// Where a session's hooks go.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRoute {
    pub terminal_id: String,
    /// The Komla its hook reached, which may differ from the one a background session's
    /// environment names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// The companion inbox of the installation it went to, on an SSH host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub companion_inbox: Option<String>,
}

/// Keeps the route a session's hook took. Best effort: without it, a session Claude moves to the
/// background reports nothing, as before.
pub(crate) fn record(directory: &Path, session_id: &str, route: &SessionRoute) {
    keep(directory, session_id, Some(route), SystemTime::now());
}

/// Keeps `route`, or None for a background session that continues no session a Terminal showed,
/// so its later hooks don't look for one again.
fn keep(directory: &Path, session_id: &str, route: Option<&SessionRoute>, now: SystemTime) {
    if !is_session_id(session_id) || fs::create_dir_all(directory).is_err() {
        return;
    }
    // Once per session, not on each of its turns.
    if !directory.join(session_id).exists() {
        forget_old(directory, now);
    }
    if let Ok(contents) = serde_json::to_vec(&route) {
        let _ = write_atomically(directory, session_id, &contents);
    }
}

fn forget_old(directory: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| now.duration_since(modified).unwrap_or_default() > KEPT_FOR);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// What is kept for a session: Some(None) when it continues no session a Terminal showed.
fn read(directory: &Path, session_id: &str) -> Option<Option<SessionRoute>> {
    if !is_session_id(session_id) {
        return None;
    }
    serde_json::from_slice(&fs::read(directory.join(session_id)).ok()?).ok()
}

/// The route of the session a background session continues, which Claude moved there from a
/// Terminal; None for one the daemon started, which no Terminal shows. `transcript` is the
/// background session's own, beside the transcript of the session it continues.
pub(crate) fn continued_route(
    directory: &Path,
    session_id: &str,
    transcript: &Path,
) -> Option<SessionRoute> {
    continued_route_at(directory, session_id, transcript, SystemTime::now())
}

fn continued_route_at(
    directory: &Path,
    session_id: &str,
    transcript: &Path,
    now: SystemTime,
) -> Option<SessionRoute> {
    // Found before, or a session that moved on again.
    let known = read(directory, session_id);
    if let Some(Some(route)) = known {
        return Some(route);
    }
    // A session found to continue none is looked for again only while it is new, in case its
    // first hooks ran before the move was written; then not again, as the daemon's own agents run
    // many hooks.
    let found_none_at = known.is_some().then(|| {
        fs::metadata(directory.join(session_id))
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    if let Some(found_at) = found_none_at {
        let settled = found_at
            .is_none_or(|found_at| now.duration_since(found_at).unwrap_or_default() > SETTLES_IN);
        if settled {
            return None;
        }
    }
    let route = continued_session(session_id, transcript)
        .and_then(|continued| read(directory, &continued).flatten());
    // Its later hooks find the route at once, and a session it moves on to finds it here. A
    // second None is not kept, so that the first one's time still counts.
    if route.is_some() || found_none_at.is_none() {
        keep(directory, session_id, route.as_ref(), now);
    }
    route
}

/// The session whose transcript says it continued in `session_id`.
fn continued_session(session_id: &str, transcript: &Path) -> Option<String> {
    if !is_session_id(session_id) {
        return None;
    }
    let mut candidates: Vec<(SystemTime, PathBuf)> = fs::read_dir(transcript.parent()?)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path != transcript && path.extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|path| Some((fs::metadata(&path).ok()?.modified().ok()?, path)))
        .collect();
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates
        .iter()
        .take(SCANNED_TRANSCRIPTS)
        .find_map(|(_, path)| continued_in(path, session_id))
}

/// The session of `transcript` when its `continued-in` record names `session_id`.
fn continued_in(transcript: &Path, session_id: &str) -> Option<String> {
    let mut file = fs::File::open(transcript).ok()?;
    let length = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(SCANNED_TAIL_BYTES)))
        .ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    String::from_utf8_lossy(&tail)
        .lines()
        .rev()
        .filter(|line| line.contains("\"continued-in\""))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|record| {
            record.get("type").and_then(Value::as_str) == Some("continued-in")
                && record.get("continuedInSessionId").and_then(Value::as_str) == Some(session_id)
        })
        .and_then(|record| record.get("sessionId")?.as_str().map(str::to_owned))
        .filter(|continued| is_session_id(continued) && continued != session_id)
}

/// A session id names a file here, so it may not name a path.
fn is_session_id(value: &str) -> bool {
    is_manifest_id(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(terminal: &str) -> SessionRoute {
        SessionRoute {
            terminal_id: terminal.to_owned(),
            api_url: Some("http://127.0.0.1:52863".to_owned()),
            workspace_id: Some("workspace".to_owned()),
            companion_inbox: Some("/helpers/companion/key/inbox".to_owned()),
        }
    }

    fn continued(project: &Path, from: &str, to: &str) {
        let mut lines = format!("{{\"type\":\"user\",\"sessionId\":\"{from}\"}}\n");
        lines += &format!(
            "{{\"type\":\"continued-in\",\"sessionId\":\"{from}\",\"continuedInSessionId\":\"{to}\"}}\n"
        );
        fs::write(project.join(format!("{from}.jsonl")), lines).unwrap();
        fs::write(project.join(format!("{to}.jsonl")), "{}\n").unwrap();
    }

    #[test]
    fn a_moved_session_takes_the_route_of_the_session_it_continues() {
        let home = tempfile::tempdir().unwrap();
        let (sessions, project) = (home.path().join("sessions"), home.path().join("project"));
        fs::create_dir_all(&project).unwrap();
        record(&sessions, "first", &route("terminal-1"));
        continued(&project, "first", "second");
        continued(&project, "second", "third");

        let second = continued_route(&sessions, "second", &project.join("second.jsonl"));
        let third = continued_route(&sessions, "third", &project.join("third.jsonl"));

        assert_eq!(second, Some(route("terminal-1")));
        assert_eq!(third, Some(route("terminal-1")));
    }

    #[test]
    fn a_session_nothing_moved_has_no_route() {
        let home = tempfile::tempdir().unwrap();
        let (sessions, project) = (home.path().join("sessions"), home.path().join("project"));
        fs::create_dir_all(&project).unwrap();
        record(&sessions, "first", &route("terminal-1"));
        continued(&project, "first", "second");
        fs::write(project.join("own.jsonl"), "{}\n").unwrap();
        // A session whose own continuation went unrecorded, as one no Terminal reported.
        continued(&project, "elsewhere", "later");

        assert_eq!(
            continued_route(&sessions, "own", &project.join("own.jsonl")),
            None
        );
        assert_eq!(
            continued_route(&sessions, "later", &project.join("later.jsonl")),
            None
        );
    }

    #[test]
    fn a_session_found_to_continue_none_is_looked_for_again_only_while_new() {
        let home = tempfile::tempdir().unwrap();
        let (sessions, project) = (home.path().join("sessions"), home.path().join("project"));
        fs::create_dir_all(&project).unwrap();
        record(&sessions, "first", &route("terminal-1"));
        record(&sessions, "second", &route("terminal-2"));
        for session in ["early", "helper"] {
            fs::write(project.join(format!("{session}.jsonl")), "{}\n").unwrap();
            assert_eq!(
                continued_route(
                    &sessions,
                    session,
                    &project.join(format!("{session}.jsonl"))
                ),
                None
            );
        }
        // The moves are written only after those sessions' first hooks.
        continued(&project, "first", "early");
        continued(&project, "second", "helper");
        let later = SystemTime::now() + SETTLES_IN + Duration::from_secs(1);

        let early = continued_route(&sessions, "early", &project.join("early.jsonl"));
        let helper = continued_route_at(&sessions, "helper", &project.join("helper.jsonl"), later);

        assert_eq!(early, Some(route("terminal-1")));
        assert_eq!(helper, None);
    }

    #[test]
    fn the_record_is_found_after_much_of_the_transcript() {
        let home = tempfile::tempdir().unwrap();
        let (sessions, project) = (home.path().join("sessions"), home.path().join("project"));
        fs::create_dir_all(&project).unwrap();
        record(&sessions, "first", &route("terminal-1"));
        let mut lines = format!("{{\"padding\":\"{}\"}}\n", "x".repeat(64 * 1024));
        lines += "{\"type\":\"continued-in\",\"sessionId\":\"first\",\"continuedInSessionId\":\"second\"}\n";
        lines += "{\"type\":\"cost-state\",\"sessionId\":\"first\"}\n";
        fs::write(project.join("first.jsonl"), lines).unwrap();
        fs::write(project.join("second.jsonl"), "{}\n").unwrap();

        assert_eq!(
            continued_route(&sessions, "second", &project.join("second.jsonl")),
            Some(route("terminal-1"))
        );
    }

    #[test]
    fn session_ids_that_name_a_path_are_neither_kept_nor_read() {
        let home = tempfile::tempdir().unwrap();
        let sessions = home.path().join("sessions");
        for id in ["", "../escape", "a/b", ".", &"x".repeat(129)] {
            record(&sessions, id, &route("terminal-1"));
            assert_eq!(read(&sessions, id), None, "{id:?}");
        }
        assert!(!home.path().join("escape").exists());
    }

    #[test]
    fn sessions_quiet_for_a_month_are_forgotten() {
        let home = tempfile::tempdir().unwrap();
        let sessions = home.path().join("sessions");
        record(&sessions, "old", &route("terminal-1"));
        let later = SystemTime::now() + KEPT_FOR + Duration::from_secs(60);

        keep(&sessions, "new", Some(&route("terminal-2")), later);

        assert_eq!(read(&sessions, "old"), None);
        assert_eq!(read(&sessions, "new"), Some(Some(route("terminal-2"))));
    }
}
