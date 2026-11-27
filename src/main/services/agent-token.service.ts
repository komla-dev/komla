// Agent Tokens: what an Outside Agent holds to call remote control's MCP route (ADR 0013).
//
// The user approves each one on the remote control page, signed in with a trusted passkey, or in
// the desktop's Settings › Remote, and it lists and starts workspaces only in the projects they
// chose. The desktop keeps only each token's SHA-256, in `remote-agent-tokens.json` in the Komla
// data dir, so the file alone lets no one in. A token ends when it expires, when the user revokes
// it, and when remote control is turned off. One a passkey approved also ends when that passkey is
// removed; one the desktop approved belongs to no passkey.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import {
  AGENT_TOKEN_LIFETIME_DAYS,
  MAX_AGENT_TOKEN_LABEL_CHARS,
  MAX_AGENT_TOKENS,
  type AgentTokenLifetimeDays,
  type AgentTokenSummary,
} from '../../shared/types/agent-token';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { createLogger } from '../lib/logger';

import { pairedDeviceRegistryService } from './paired-device-registry.service';
import { ensureKomlaBasePath } from './paths';
import { projectService } from './project.service';

const logger = createLogger('AgentTokenService');

const FILE_NAME = 'remote-agent-tokens.json';
const FILE_MODE = 0o600;
const FILE_VERSION = 1;
const DAY_MS = 24 * 60 * 60_000;
/** Recording each use would write the file on every MCP request. */
const LAST_USED_RESOLUTION_MS = 60_000;
export const AGENT_TOKEN_PREFIX = 'komla_agent_';
const TOKEN_PATTERN = /^komla_agent_[A-Za-z0-9_-]{43}$/;

/**
 * Who approved a token: a remote control session, by the passkey it signed in with, or the
 * desktop itself. Only a passkey's tokens end when that passkey is removed.
 */
export type AgentTokenApprover = { kind: 'passkey'; credentialId: string } | { kind: 'desktop' };

/** A stored token: its summary, its hash and who approved it. */
export interface AgentTokenRecord extends AgentTokenSummary {
  tokenHash: string;
  approvedBy: AgentTokenApprover;
}

/** What an SSH host needs to check a token itself while the desktop is off (ADR 0013). */
export interface HostAgentToken {
  id: string;
  tokenHash: string;
  projectIds: string[];
  expiresAt: number | null;
}

export interface CreateAgentTokenRequest {
  label: string;
  projectIds: readonly string[];
  lifetimeDays: AgentTokenLifetimeDays;
  /** False only when the user chose to let the agent reach this computer too. */
  sshOnly?: boolean;
  approvedBy: AgentTokenApprover;
}

/**
 * A token as the file keeps it. A passkey's token is stored as it was before the desktop could
 * approve, under its `credentialId`, so a Komla from before then still reads it back; the desktop's
 * says `approvedBy: 'desktop'` instead, which such a build drops rather than misreads.
 */
type StoredAgentToken = Omit<AgentTokenRecord, 'approvedBy'> &
  ({ credentialId: string } | { approvedBy: 'desktop' });

interface TokensFileV1 {
  version: 1;
  tokens: StoredAgentToken[];
}

export interface AgentTokenServiceDeps {
  path?: string;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  projects?: { list(): Array<{ id: string }> };
  devices?: {
    list(): Array<{ credentialId: string }>;
    onChange(listener: () => void): () => void;
  };
}

export class AgentTokenService {
  private readonly explicitPath: string | null;
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  private readonly devices: NonNullable<AgentTokenServiceDeps['devices']>;
  private readonly projects: NonNullable<AgentTokenServiceDeps['projects']>;
  private tokens: AgentTokenRecord[] | null = null;
  private readonly listeners = new Set<(tokens: AgentTokenSummary[]) => void>();
  private unsubscribeDevices: (() => void) | null = null;

  constructor(deps: AgentTokenServiceDeps = {}) {
    this.explicitPath = deps.path ?? null;
    this.now = deps.now ?? Date.now;
    this.random = deps.randomBytes ?? randomBytes;
    this.devices = deps.devices ?? pairedDeviceRegistryService;
    this.projects = deps.projects ?? projectService;
  }

  /** Ends a passkey's tokens as soon as the passkey is removed. */
  start(): void {
    if (this.unsubscribeDevices) return;
    this.unsubscribeDevices = this.devices.onChange(() => this.pruneRemovedDevices());
  }

  stop(): void {
    this.unsubscribeDevices?.();
    this.unsubscribeDevices = null;
  }

  onChange(listener: (tokens: AgentTokenSummary[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The tokens that still work, newest first. */
  list(): AgentTokenSummary[] {
    return this.live()
      .map(summarize)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Makes a token and returns it, the only time it exists outside the Outside Agent. The remote
   * control page and the desktop both approve through here, so they share every rule.
   */
  create(request: CreateAgentTokenRequest): { token: string; summary: AgentTokenSummary } {
    const label = request.label.replace(/\s+/g, ' ').trim();
    if (!label || label.length > MAX_AGENT_TOKEN_LABEL_CHARS) {
      throw new Error(`Name the agent in 1 to ${MAX_AGENT_TOKEN_LABEL_CHARS} characters.`);
    }
    const projectIds = [...new Set(request.projectIds)];
    if (projectIds.length === 0) throw new Error('Choose at least one project.');
    const known = new Set(this.projects.list().map((project) => project.id));
    if (projectIds.some((id) => !known.has(id))) {
      throw new Error('One of those projects no longer exists.');
    }
    if (!AGENT_TOKEN_LIFETIME_DAYS.includes(request.lifetimeDays)) {
      throw new Error('Choose how long the token works.');
    }
    const { approvedBy } = request;
    if (
      approvedBy.kind === 'passkey' &&
      !this.devices.list().some((device) => device.credentialId === approvedBy.credentialId)
    ) {
      throw new Error('This device is no longer trusted.');
    }
    const live = this.live();
    if (live.length >= MAX_AGENT_TOKENS) {
      throw new Error(`Komla keeps at most ${MAX_AGENT_TOKENS} agent tokens. Revoke one first.`);
    }
    const token = `${AGENT_TOKEN_PREFIX}${this.random(32).toString('base64url')}`;
    const createdAt = this.now();
    const record: AgentTokenRecord = {
      id: this.random(12).toString('base64url'),
      label,
      projectIds,
      sshOnly: request.sshOnly !== false,
      createdAt,
      expiresAt: request.lifetimeDays === null ? null : createdAt + request.lifetimeDays * DAY_MS,
      tokenHash: hashToken(token),
      approvedBy:
        approvedBy.kind === 'passkey'
          ? { kind: 'passkey', credentialId: approvedBy.credentialId }
          : { kind: 'desktop' },
    };
    this.save([...live, record]);
    return { token, summary: summarize(record) };
  }

  /** The live token a bearer value names, recording that it was used. */
  authenticate(bearer: string): AgentTokenRecord | null {
    if (!TOKEN_PATTERN.test(bearer)) return null;
    const hash = Buffer.from(hashToken(bearer), 'hex');
    const record = this.live().find((candidate) =>
      timingSafeEqual(Buffer.from(candidate.tokenHash, 'hex'), hash)
    );
    if (!record) return null;
    const now = this.now();
    if (now - (record.lastUsedAt ?? 0) >= LAST_USED_RESOLUTION_MS) {
      this.save(
        this.load().map((candidate) =>
          candidate.id === record.id ? { ...candidate, lastUsedAt: now } : candidate
        )
      );
    }
    return record;
  }

  /** The live tokens as the Where-agents-start host gets them: hashes, never labels or secrets. */
  hostShares(): HostAgentToken[] {
    return this.live().map(({ id, tokenHash, projectIds, expiresAt }) => ({
      id,
      tokenHash,
      projectIds: [...projectIds],
      expiresAt,
    }));
  }

  revoke(id: string): boolean {
    const tokens = this.load();
    const remaining = tokens.filter((token) => token.id !== id);
    if (remaining.length === tokens.length) return false;
    this.save(remaining);
    return true;
  }

  /** Turning remote control off ends every token, as it ends every resume grant. */
  revokeAll(): void {
    if (this.load().length > 0) this.save([]);
  }

  private pruneRemovedDevices(): void {
    const tokens = this.load();
    const remaining = this.withTrustedApprovers(tokens);
    if (remaining.length !== tokens.length) this.save(remaining);
  }

  /** Drops the tokens whose approving passkey is gone; the desktop's own stay. */
  private withTrustedApprovers(tokens: AgentTokenRecord[]): AgentTokenRecord[] {
    const trusted = new Set(this.devices.list().map((device) => device.credentialId));
    return tokens.filter(
      ({ approvedBy }) => approvedBy.kind === 'desktop' || trusted.has(approvedBy.credentialId)
    );
  }

  private live(): AgentTokenRecord[] {
    const now = this.now();
    return this.load().filter((token) => isLive(token, now));
  }

  private get path(): string {
    return this.explicitPath ?? join(ensureKomlaBasePath(), FILE_NAME);
  }

  private load(): AgentTokenRecord[] {
    if (this.tokens) return this.tokens;
    let tokens: AgentTokenRecord[] = [];
    try {
      if (existsSync(this.path)) {
        tokens = parseTokensFile(JSON.parse(readFileSync(this.path, 'utf8')));
      }
    } catch (err) {
      logger.warn('agent tokens are unreadable; starting empty', { error: String(err) });
    }
    this.tokens = this.withTrustedApprovers(tokens);
    return this.tokens;
  }

  private save(tokens: AgentTokenRecord[]): void {
    const now = this.now();
    // Expired tokens go at the next write, so the file doesn't keep their hashes.
    this.tokens = tokens.filter((token) => isLive(token, now));
    const file: TokensFileV1 = { version: FILE_VERSION, tokens: this.tokens.map(toStored) };
    writeFileAtomicSync(this.path, JSON.stringify(file, null, 2), FILE_MODE);
    const summaries = this.list();
    for (const listener of this.listeners) listener(summaries);
  }
}

function isLive(token: AgentTokenRecord, now: number): boolean {
  return token.expiresAt === null || token.expiresAt > now;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function summarize({ tokenHash: _hash, approvedBy: _approver, ...summary }: AgentTokenRecord) {
  return { ...summary, projectIds: [...summary.projectIds] };
}

function toStored({ approvedBy, ...record }: AgentTokenRecord): StoredAgentToken {
  return approvedBy.kind === 'passkey'
    ? { ...record, credentialId: approvedBy.credentialId }
    : { ...record, approvedBy: 'desktop' };
}

function parseTokensFile(value: unknown): AgentTokenRecord[] {
  const file = (value ?? {}) as Partial<TokensFileV1>;
  if (file.version !== FILE_VERSION || !Array.isArray(file.tokens)) return [];
  return (file.tokens as unknown[]).flatMap((token) => {
    if (!token || typeof token !== 'object') return [];
    const { credentialId, approvedBy, ...rest } = token as Record<string, unknown>;
    // A record naming both, or neither, is not one this service wrote.
    let approver: AgentTokenApprover;
    if (typeof credentialId === 'string' && approvedBy === undefined) {
      approver = { kind: 'passkey', credentialId };
    } else if (approvedBy === 'desktop' && credentialId === undefined) {
      approver = { kind: 'desktop' };
    } else {
      return [];
    }
    const record = { ...rest, approvedBy: approver };
    return isTokenRecord(record) ? [record] : [];
  });
}

function isTokenRecord(value: unknown): value is AgentTokenRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AgentTokenRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.label === 'string' &&
    Array.isArray(record.projectIds) &&
    record.projectIds.every((id) => typeof id === 'string') &&
    typeof record.sshOnly === 'boolean' &&
    typeof record.createdAt === 'number' &&
    (record.expiresAt === null || typeof record.expiresAt === 'number') &&
    (record.lastUsedAt === undefined || typeof record.lastUsedAt === 'number') &&
    typeof record.tokenHash === 'string' &&
    /^[0-9a-f]{64}$/.test(record.tokenHash)
  );
}

export const agentTokenService = new AgentTokenService();
