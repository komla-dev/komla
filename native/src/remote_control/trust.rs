//! The phones a desktop lets reach this host, copied from its trusted-device registry over SSH,
//! and the Agent Tokens it lets Outside Agents call this host's MCP route with (ADR 0013).
//! The desktop rewrites the file whenever a phone or token is added or removed and renews
//! `expiresAt` each time it connects; once the lease runs out the host trusts no phone and no
//! token from that desktop.

use std::fs;
use std::path::Path;

use anyhow::{bail, Context};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::crypto::{fingerprint, public_key_from_spki};
use super::peer::decode_base64;
use super::resume::DEFAULT_RESUME_WINDOW_MS;

const TRUST_FILE_VERSION: u32 = 1;
const MAX_TRUST_FILE_BYTES: u64 = 512 * 1024;
const AGENT_TOKEN_PREFIX: &str = "komla_agent_";
/// 32 random bytes in unpadded base64url.
const AGENT_TOKEN_SECRET_CHARS: usize = 43;
const MAX_ID_CHARS: usize = 128;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustFile {
    version: u32,
    /// Milliseconds since the epoch.
    expires_at: u64,
    /// How long a phone that left may come back without its passkey.
    #[serde(default)]
    resume_window_ms: Option<u64>,
    devices: Vec<TrustedDeviceRecord>,
    /// Missing in files from before Agent Tokens reached hosts, which trust none. Each is read on
    /// its own, so one this host can't use doesn't keep phones' trust from reaching it.
    #[serde(default)]
    agent_tokens: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentTokenRecord {
    id: String,
    /// Lowercase hex SHA-256 of the whole token; the token itself never leaves the desktop.
    token_hash: String,
    project_ids: Vec<String>,
    /// Milliseconds since the epoch, or null for a token that works until revoked.
    expires_at: Option<u64>,
}

/// An Agent Token an Outside Agent may call this host's MCP route with.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AgentToken {
    pub(crate) id: String,
    token_hash: [u8; 32],
    /// The projects it may list and start workspaces in.
    pub(crate) project_ids: Vec<String>,
    expires_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedDeviceRecord {
    device_id: String,
    /// Standard base64 SPKI of the browser installation key.
    device_public_key: String,
    /// base64url passkey credential id.
    credential_id: String,
    /// Standard base64 SPKI of the passkey's ES256 public key.
    credential_public_key: String,
    label: String,
    rp_id: String,
    origin: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TrustedDevice {
    pub(crate) device_id: String,
    pub(crate) device_public_key: Vec<u8>,
    pub(crate) credential_id: String,
    pub(crate) credential_public_key: Vec<u8>,
    pub(crate) label: String,
    pub(crate) rp_id: String,
    pub(crate) origin: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Trust {
    devices: Vec<TrustedDevice>,
    agent_tokens: Vec<AgentToken>,
    expires_at: u64,
    resume_window_ms: Option<u64>,
}

impl Trust {
    pub(crate) fn parse(bytes: &[u8]) -> anyhow::Result<Self> {
        let file: TrustFile =
            serde_json::from_slice(bytes).context("phone trust file is malformed")?;
        if file.version != TRUST_FILE_VERSION {
            bail!("phone trust file version {} is not supported", file.version);
        }
        let devices = file
            .devices
            .into_iter()
            .map(TrustedDevice::from_record)
            .collect::<anyhow::Result<Vec<_>>>()?;
        let agent_tokens = file
            .agent_tokens
            .into_iter()
            .filter_map(|value| {
                let token = serde_json::from_value::<AgentTokenRecord>(value)
                    .map_err(anyhow::Error::from)
                    .and_then(AgentToken::from_record);
                token
                    .inspect_err(|cause| {
                        eprintln!("phone trust: skipped an agent token: {cause:#}")
                    })
                    .ok()
            })
            .collect();
        Ok(Self {
            devices,
            agent_tokens,
            expires_at: file.expires_at,
            resume_window_ms: file.resume_window_ms,
        })
    }

    /// Settings → Remote → "Ask for passkey again after" on the desktop.
    pub(crate) fn resume_window_ms(&self) -> u64 {
        self.resume_window_ms.unwrap_or(DEFAULT_RESUME_WINDOW_MS)
    }

    /// The device with `device_id`, unless the lease has run out.
    pub(crate) fn device(&self, device_id: &str, now_ms: u64) -> Option<&TrustedDevice> {
        if now_ms >= self.expires_at {
            return None;
        }
        self.devices
            .iter()
            .find(|device| device.device_id == device_id)
    }

    /// The trusted phone whose passkey this is, which any browser may sign in with.
    pub(crate) fn credential(&self, credential_id: &str, now_ms: u64) -> Option<&TrustedDevice> {
        if now_ms >= self.expires_at {
            return None;
        }
        self.devices
            .iter()
            .find(|device| device.credential_id == credential_id)
    }

    /// The RP ID of the passkeys trusted for pages on `origin`.
    pub(crate) fn rp_id_for(&self, origin: &str, now_ms: u64) -> Option<&str> {
        if now_ms >= self.expires_at {
            return None;
        }
        self.devices
            .iter()
            .find(|device| device.origin == origin)
            .map(|device| device.rp_id.as_str())
    }

    /// The live Agent Token a bearer value names, unless it or the lease has expired.
    pub(crate) fn agent_token(&self, bearer: &str, now_ms: u64) -> Option<&AgentToken> {
        if now_ms >= self.expires_at || !is_agent_token(bearer) {
            return None;
        }
        let hash: [u8; 32] = Sha256::digest(bearer.as_bytes()).into();
        // Every stored hash is compared in full, so timing says nothing about which one matched.
        let mut found = None;
        for token in &self.agent_tokens {
            if same_hash(&token.token_hash, &hash) && found.is_none() {
                found = Some(token);
            }
        }
        found.filter(|token| {
            token
                .expires_at
                .is_none_or(|expires_at| now_ms < expires_at)
        })
    }

    /// Browser origins a WebSocket upgrade may come from: those of the trusted phones.
    pub(crate) fn allows_origin(&self, origin: &str, now_ms: u64) -> bool {
        now_ms < self.expires_at && self.devices.iter().any(|device| device.origin == origin)
    }
}

/// The trust file's bytes, or None when there is none, which trusts nobody.
fn read_trust_file(path: &Path) -> anyhow::Result<Option<Vec<u8>>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("could not read the phone trust file"),
    };
    if metadata.len() > MAX_TRUST_FILE_BYTES {
        bail!("phone trust file is too large");
    }
    Ok(Some(
        fs::read(path).context("could not read the phone trust file")?,
    ))
}

/// The last good copy of the trust file, reread whenever its contents change.
#[derive(Default)]
pub(crate) struct TrustFileCache {
    trust: Trust,
    bytes: Option<Vec<u8>>,
}

impl TrustFileCache {
    /// The trust file as of now. Compared by content: two rewrites within the filesystem's
    /// timestamp granularity share a modification time. A file the desktop is mid-way through
    /// replacing keeps the last good copy.
    pub(crate) fn current(&mut self, path: &Path) -> Trust {
        let reloaded = read_trust_file(path).and_then(|bytes| {
            if bytes.is_some() && bytes == self.bytes {
                return Ok(None);
            }
            let trust = bytes
                .as_deref()
                .map_or_else(|| Ok(Trust::default()), Trust::parse)?;
            Ok(Some((trust, bytes)))
        });
        match reloaded {
            Ok(Some((trust, bytes))) => {
                self.trust = trust;
                self.bytes = bytes;
            }
            Ok(None) => {}
            Err(error) => eprintln!("phone trust file not reloaded: {error:#}"),
        }
        self.trust.clone()
    }
}

/// HTTPS, with plain-HTTP localhost as the development exception the desktop also makes.
fn is_allowed_origin(origin: &str) -> bool {
    if origin.starts_with("https://") {
        return true;
    }
    let Some(rest) = origin
        .strip_prefix("http://localhost:")
        .or_else(|| origin.strip_prefix("http://127.0.0.1:"))
    else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())
}

/// `komla_agent_` and 43 base64url characters, as the desktop makes them.
fn is_agent_token(value: &str) -> bool {
    value
        .strip_prefix(AGENT_TOKEN_PREFIX)
        .is_some_and(|secret| {
            secret.len() == AGENT_TOKEN_SECRET_CHARS
                && secret
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        })
}

fn same_hash(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

/// The lowercase hex SHA-256 the desktop stores for a token.
#[cfg(test)]
pub(crate) fn hash_agent_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn decode_hash(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    let mut hash = [0u8; 32];
    for (index, byte) in hash.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(hash)
}

fn is_id(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= MAX_ID_CHARS
}

impl AgentToken {
    fn from_record(record: AgentTokenRecord) -> anyhow::Result<Self> {
        let token_hash =
            decode_hash(&record.token_hash).context("agent token hash is not lowercase hex")?;
        if !is_id(&record.id)
            || record.project_ids.is_empty()
            || !record.project_ids.iter().all(|id| is_id(id))
        {
            bail!("agent token record is incomplete");
        }
        Ok(Self {
            id: record.id,
            token_hash,
            project_ids: record.project_ids,
            expires_at: record.expires_at,
        })
    }
}

impl TrustedDevice {
    fn from_record(record: TrustedDeviceRecord) -> anyhow::Result<Self> {
        let device_public_key =
            decode_base64(&record.device_public_key).context("devicePublicKey is not base64")?;
        public_key_from_spki(&device_public_key).context("devicePublicKey")?;
        if fingerprint(&device_public_key) != record.device_id {
            bail!("deviceId does not match devicePublicKey");
        }
        let credential_public_key = decode_base64(&record.credential_public_key)
            .context("credentialPublicKey is not base64")?;
        public_key_from_spki(&credential_public_key).context("credentialPublicKey")?;
        if record.credential_id.is_empty() || record.label.is_empty() || record.rp_id.is_empty() {
            bail!("trusted phone record is incomplete");
        }
        if !is_allowed_origin(&record.origin) {
            bail!("trusted phone origin must be https (or localhost while developing)");
        }
        Ok(Self {
            device_id: record.device_id,
            device_public_key,
            credential_id: record.credential_id,
            credential_public_key,
            label: record.label,
            rp_id: record.rp_id,
            origin: record.origin,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::remote_control::crypto::HostIdentity;
    use crate::remote_control::peer::encode_base64;

    pub(crate) const ORIGIN: &str = "https://mac.tail1.ts.net";

    pub(crate) fn record(device_key: &[u8], credential_key: &[u8]) -> serde_json::Value {
        serde_json::json!({
            "deviceId": fingerprint(device_key),
            "devicePublicKey": encode_base64(device_key),
            "credentialId": "Y3JlZGVudGlhbC0x",
            "credentialPublicKey": encode_base64(credential_key),
            "label": "iPhone",
            "rpId": "mac.tail1.ts.net",
            "origin": ORIGIN,
        })
    }

    pub(crate) fn trust_json(devices: Vec<serde_json::Value>, expires_at: u64) -> Vec<u8> {
        serde_json::json!({ "version": 1, "expiresAt": expires_at, "devices": devices })
            .to_string()
            .into_bytes()
    }

    #[test]
    fn finds_trusted_phones_until_the_lease_runs_out() {
        let device = HostIdentity::generate();
        let credential = HostIdentity::generate();
        let trust = Trust::parse(&trust_json(
            vec![record(device.spki_der(), credential.spki_der())],
            1_000,
        ))
        .unwrap();

        let found = trust.device(&device.fingerprint(), 999).unwrap();
        assert_eq!(found.label, "iPhone");
        assert!(trust.allows_origin(ORIGIN, 999));
        assert!(!trust.allows_origin("https://other.ts.net", 999));
        assert!(trust.device(&device.fingerprint(), 1_000).is_none());
        assert!(!trust.allows_origin(ORIGIN, 1_000));
    }

    #[test]
    fn rejects_records_that_do_not_hold_together() {
        let device = HostIdentity::generate();
        let credential = HostIdentity::generate();
        let mut wrong_id = record(device.spki_der(), credential.spki_der());
        wrong_id["deviceId"] = serde_json::Value::String("0".repeat(64));
        let mut plain_origin = record(device.spki_der(), credential.spki_der());
        plain_origin["origin"] = serde_json::Value::String("http://mac.tail1.ts.net".to_owned());
        let mut localhost_path = record(device.spki_der(), credential.spki_der());
        localhost_path["origin"] =
            serde_json::Value::String("http://localhost:52864/remote".to_owned());
        let mut bad_key = record(device.spki_der(), credential.spki_der());
        bad_key["credentialPublicKey"] = serde_json::Value::String("AAAA".to_owned());

        let mut localhost = record(device.spki_der(), credential.spki_der());
        localhost["origin"] = serde_json::Value::String("http://localhost:52864".to_owned());
        assert!(Trust::parse(&trust_json(vec![localhost], u64::MAX)).is_ok());

        for record in [wrong_id, plain_origin, localhost_path, bad_key] {
            assert!(Trust::parse(&trust_json(vec![record], u64::MAX)).is_err());
        }
        assert!(Trust::parse(br#"{"version":2,"expiresAt":1,"devices":[]}"#).is_err());
    }

    #[test]
    fn reads_the_desktops_passkey_window() {
        let mut file: serde_json::Value =
            serde_json::from_slice(&trust_json(Vec::new(), u64::MAX)).unwrap();
        assert_eq!(
            Trust::parse(file.to_string().as_bytes())
                .unwrap()
                .resume_window_ms(),
            DEFAULT_RESUME_WINDOW_MS
        );

        file["resumeWindowMs"] = serde_json::json!(3_600_000);
        assert_eq!(
            Trust::parse(file.to_string().as_bytes())
                .unwrap()
                .resume_window_ms(),
            3_600_000
        );
    }

    #[test]
    fn rereads_a_rewrite_that_kept_the_modification_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trust.json");
        let first = HostIdentity::generate();
        let second = HostIdentity::generate();
        let credential = HostIdentity::generate();
        let write = |device: &HostIdentity| {
            fs::write(
                &path,
                trust_json(
                    vec![record(device.spki_der(), credential.spki_der())],
                    u64::MAX,
                ),
            )
            .unwrap();
            fs::File::options()
                .write(true)
                .open(&path)
                .and_then(|file| file.set_modified(std::time::SystemTime::UNIX_EPOCH))
                .unwrap();
        };
        let mut cache = TrustFileCache::default();

        write(&first);
        assert!(cache
            .current(&path)
            .device(&first.fingerprint(), 0)
            .is_some());
        write(&second);
        let trust = cache.current(&path);

        assert!(trust.device(&first.fingerprint(), 0).is_none());
        assert!(trust.device(&second.fingerprint(), 0).is_some());
        fs::write(&path, b"{").unwrap();
        assert!(cache
            .current(&path)
            .device(&second.fingerprint(), 0)
            .is_some());
        fs::remove_file(&path).unwrap();
        assert_eq!(cache.current(&path), Trust::default());
    }

    const TOKEN: &str = "komla_agent_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn token_record(token: &str, expires_at: Option<u64>) -> serde_json::Value {
        serde_json::json!({
            "id": "tok-1",
            "tokenHash": hash_agent_token(token),
            "projectIds": ["p-app"],
            "expiresAt": expires_at,
        })
    }

    fn trust_with_tokens(tokens: Vec<serde_json::Value>, expires_at: u64) -> Trust {
        let mut file: serde_json::Value =
            serde_json::from_slice(&trust_json(Vec::new(), expires_at)).unwrap();
        file["agentTokens"] = serde_json::Value::Array(tokens);
        Trust::parse(file.to_string().as_bytes()).unwrap()
    }

    #[test]
    fn finds_an_agent_token_by_its_hash_until_it_or_the_lease_expires() {
        let trust = trust_with_tokens(vec![token_record(TOKEN, Some(500))], 1_000);

        let found = trust.agent_token(TOKEN, 499).unwrap();
        assert_eq!(found.id, "tok-1");
        assert_eq!(found.project_ids, vec!["p-app".to_owned()]);
        // The token's own expiry, then the desktop's lease, each end it.
        assert!(trust.agent_token(TOKEN, 500).is_none());
        let forever = trust_with_tokens(vec![token_record(TOKEN, None)], 1_000);
        assert!(forever.agent_token(TOKEN, 999).is_some());
        assert!(forever.agent_token(TOKEN, 1_000).is_none());
    }

    #[test]
    fn refuses_tokens_it_was_not_given_and_malformed_ones() {
        let trust = trust_with_tokens(vec![token_record(TOKEN, None)], u64::MAX);
        let other = "komla_agent_BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

        assert!(trust.agent_token(other, 0).is_none());
        assert!(trust.agent_token("", 0).is_none());
        assert!(trust.agent_token(&format!("Bearer {TOKEN}"), 0).is_none());
        assert!(trust.agent_token(&format!("{TOKEN}A"), 0).is_none());
        // A trust file from before Agent Tokens reached hosts has none.
        assert!(Trust::parse(&trust_json(Vec::new(), u64::MAX))
            .unwrap()
            .agent_token(TOKEN, 0)
            .is_none());
    }

    #[test]
    fn skips_agent_token_records_that_do_not_hold_together() {
        let mut short_hash = token_record(TOKEN, None);
        short_hash["tokenHash"] = serde_json::Value::String("ab".to_owned());
        let mut upper_hash = token_record(TOKEN, None);
        upper_hash["tokenHash"] =
            serde_json::Value::String(hash_agent_token(TOKEN).to_ascii_uppercase());
        let mut no_projects = token_record(TOKEN, None);
        no_projects["projectIds"] = serde_json::json!([]);
        let mut extra = token_record(TOKEN, None);
        extra["credentialId"] = serde_json::Value::String("passkey".to_owned());

        let other = format!("komla_agent_{}", "Z".repeat(43));
        for record in [short_hash, upper_hash, no_projects, extra] {
            let mut file: serde_json::Value =
                serde_json::from_slice(&trust_json(Vec::new(), u64::MAX)).unwrap();
            file["agentTokens"] = serde_json::json!([record, token_record(&other, None)]);
            let trust = Trust::parse(file.to_string().as_bytes()).unwrap();
            assert!(trust.agent_token(TOKEN, 0).is_none());
            // The rest of the file still holds.
            assert!(trust.agent_token(&other, 0).is_some());
        }
    }

    #[test]
    fn a_missing_file_trusts_nobody() {
        let dir = tempfile::tempdir().unwrap();

        let trust = TrustFileCache::default().current(&dir.path().join("trust.json"));

        assert_eq!(trust, Trust::default());
    }
}
