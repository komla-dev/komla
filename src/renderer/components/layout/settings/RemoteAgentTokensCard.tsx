import { Copy, Plus, Robot, Trash } from '@phosphor-icons/react';
import { useEffect, useId, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { useConfigStore } from '@/stores/config.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';

import {
  AGENT_TOKEN_LIFETIME_DAYS,
  MAX_AGENT_TOKEN_LABEL_CHARS,
  type AgentTokenCreated,
  type AgentTokenLifetimeDays,
  type AgentTokenSummary,
} from '../../../../shared/types/agent-token';

import { SettingsCard } from './SettingsCard';

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_LIFETIME = '30';
const NEVER = 'never';

/** The Agent Tokens Outside Agents hold (ADR 0013), each with a way to revoke it. */
export function useAgentTokens() {
  const [tokens, setTokens] = useState<AgentTokenSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    // A change that arrives first is newer than the list asked for before it.
    let changed = false;
    void window.api.agentTokensList().then((list) => {
      if (!cancelled && !changed) setTokens(list);
    });
    const off = window.api.onAgentTokensChanged((list) => {
      changed = true;
      setTokens(list);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return tokens;
}

/** When a token stops working, and when its agent last called, as a row's second line. */
export function agentTokenDetail(token: AgentTokenSummary, now = Date.now()): string {
  const where = token.sshOnly ? 'SSH hosts only' : 'SSH hosts and this computer';
  if (token.expiresAt !== null && token.expiresAt <= now) return `${where} · Expired`;
  const days =
    token.expiresAt === null ? 0 : Math.max(1, Math.ceil((token.expiresAt - now) / DAY_MS));
  const expires = `${where} · ${
    token.expiresAt === null ? 'Never expires' : `Expires in ${days} day${days === 1 ? '' : 's'}`
  }`;
  return token.lastUsedAt
    ? `${expires} · Last used ${new Date(token.lastUsedAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })}`
    : `${expires} · Never used`;
}

interface RemoteAgentTokensCardProps {
  /** Where an Outside Agent calls, once the server is up. */
  mcpUrl: string | null;
  /** Remote control's switch is on: its server runs, or Komla keeps retrying it. */
  remoteOn: boolean;
  /** "Allow access to this computer", which decides whether a token may reach it too. */
  localAccess: boolean;
  /**
   * The Where-agents-start host's own route, once it serves one: it checks tokens itself, so an
   * agent limited to SSH hosts keeps working there while this computer is off.
   */
  hostMcp?: { hostName: string; url: string } | null;
}

/**
 * Settings › Remote's Agent Tokens (ADR 0013). The desktop approves one here as the remote control
 * page does, with the same choices, and lists and revokes every token wherever it was approved.
 */
export function RemoteAgentTokensCard({
  mcpUrl,
  remoteOn,
  localAccess,
  hostMcp = null,
}: RemoteAgentTokensCardProps) {
  const tokens = useAgentTokens();
  const projects = useProjectsStore((s) => s.projects);
  const addToast = useToastStore((s) => s.addToast);
  const agentSshHostId = useConfigStore((s) => s.config?.agentLaunchDefaultSshHostId);
  const [view, setView] = useState<'list' | 'form' | AgentTokenCreated>('list');

  // Turning remote control off revokes every token, so one shown once must not come back after.
  useEffect(() => {
    if (!remoteOn) setView('list');
  }, [remoteOn]);

  // Turning remote control off ends every token, so there is nothing to show then.
  if (!remoteOn && tokens.length === 0) return null;
  // Agents start on this computer until Where agents start names an SSH host, so an SSH-only
  // token could start nothing.
  const sshOnlyStuck = !agentSshHostId && tokens.some((token) => token.sshOnly);

  const projectNames = (ids: string[]) =>
    ids.map((id) => projects.find((project) => project.id === id)?.name ?? 'Removed project');

  const copy = (text: string, what: string) => {
    window.api.copyToClipboard(text);
    addToast(`${what} copied`, 'success');
  };

  const revoke = async (token: AgentTokenSummary) => {
    const where = hostMcp
      ? ` here at once; ${hostMcp.hostName} stops taking it the next time Komla connects to it`
      : ' at once';
    if (!window.confirm(`Revoke "${token.label}"? It stops working${where}.`)) return;
    try {
      await window.api.agentTokensRevoke(token.id);
      addToast(`Revoked ${token.label}`, 'success');
    } catch (err) {
      addToast(`Could not revoke the token: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <SettingsCard
      title="Agent access"
      description="Outside Agents on your tailnet start workspaces with an Agent Token, only in the projects you choose."
      action={
        view === 'list' && remoteOn ? (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={projects.length === 0}
            onClick={() => setView('form')}
          >
            <Plus className="size-3.5" />
            Add an agent
          </Button>
        ) : undefined
      }
    >
      {/* The form says so itself, for the token it would make. */}
      {sshOnlyStuck && view !== 'form' && <SshHostNeededWarning />}
      {view === 'list' && tokens.length === 0 && (
        <EmptyState
          size="sm"
          icon={<Robot weight="duotone" />}
          title="No agents yet"
          description={
            projects.length === 0
              ? 'Add a project to give an agent access.'
              : 'Approve an Agent Token for an Outside Agent to start workspaces.'
          }
        />
      )}
      {view === 'form' && (
        <AgentTokenForm
          localAccess={localAccess}
          onCancel={() => setView('list')}
          onCreated={(created) => setView(created)}
        />
      )}
      {typeof view === 'object' && (
        <div className="space-y-3 rounded-lg border border-border/60 p-3">
          <p className="text-ui text-muted-foreground">
            Copy the Agent Token for {view.summary.label} now. Komla won't show it again.
          </p>
          <SecretRow
            label="Token"
            value={view.token}
            copyLabel="Copy token"
            onCopy={() => copy(view.token, 'Token')}
          />
          {view.summary.sshOnly && hostMcp ? (
            <>
              <SecretRow
                label="MCP address"
                value={hostMcp.url}
                copyLabel="Copy MCP address"
                onCopy={() => copy(hostMcp.url, 'MCP address')}
              />
              <p className="text-ui text-muted-foreground">
                {hostMcp.hostName} answers it itself, so it works while this computer is off.
              </p>
            </>
          ) : (
            mcpUrl && (
              <SecretRow
                label="MCP address"
                value={mcpUrl}
                copyLabel="Copy MCP address"
                onCopy={() => copy(mcpUrl, 'MCP address')}
              />
            )
          )}
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setView('list')}>
              Done
            </Button>
          </div>
        </div>
      )}
      {view === 'list' && mcpUrl && tokens.length > 0 && (
        <AddressRow
          intro="Agents call"
          url={mcpUrl}
          copyLabel="Copy MCP address"
          onCopy={() => copy(mcpUrl, 'MCP address')}
        />
      )}
      {view === 'list' && hostMcp && tokens.some((token) => token.sshOnly) && (
        <AddressRow
          intro="With this computer off, agents limited to SSH hosts call"
          url={hostMcp.url}
          copyLabel={`Copy ${hostMcp.hostName}'s MCP address`}
          onCopy={() => copy(hostMcp.url, 'MCP address')}
        />
      )}
      {tokens.map((token) => (
        <div key={token.id} className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/6 text-muted-foreground">
            <Robot className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{token.label}</p>
            <p className="truncate text-ui text-muted-foreground">
              {projectNames(token.projectIds).join(', ')} · {agentTokenDetail(token)}
            </p>
          </div>
          <IconButton
            label={`Revoke ${token.label}`}
            size="md"
            className="text-muted-foreground hover:bg-error/10 hover:text-error"
            onClick={() => void revoke(token)}
          >
            <Trash className="size-3.5" />
          </IconButton>
        </div>
      ))}
    </SettingsCard>
  );
}

function AddressRow({
  intro,
  url,
  copyLabel,
  onCopy,
}: {
  intro: string;
  url: string;
  copyLabel: string;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-ui text-muted-foreground">
      <span className="min-w-0 truncate">
        {intro} <span className="font-mono">{url}</span>
      </span>
      <IconButton label={copyLabel} size="sm" onClick={onCopy}>
        <Copy className="size-3.5" />
      </IconButton>
    </div>
  );
}

function SshHostNeededWarning() {
  return (
    <p className="text-ui text-warning">
      Agents limited to SSH hosts can't start workspaces until you pick an SSH host under Where
      agents start in Settings › Integrations & MCP.
    </p>
  );
}

function SecretRow({
  label,
  value,
  copyLabel,
  onCopy,
}: {
  label: string;
  value: string;
  copyLabel: string;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-ui text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded-md bg-foreground/6 px-2 py-1 font-mono text-xs break-all text-foreground select-all">
          {value}
        </code>
        <IconButton label={copyLabel} size="md" onClick={onCopy}>
          <Copy className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

/** The remote control page's choices: name, projects, where it may work and for how long. */
function AgentTokenForm({
  localAccess,
  onCancel,
  onCreated,
}: {
  localAccess: boolean;
  onCancel: () => void;
  onCreated: (created: AgentTokenCreated) => void;
}) {
  const projects = useProjectsStore((s) => s.projects);
  const agentSshHostId = useConfigStore((s) => s.config?.agentLaunchDefaultSshHostId);
  const id = useId();
  const [label, setLabel] = useState('');
  // One project is the obvious choice when it's the only one.
  const [projectIds, setProjectIds] = useState<string[]>(
    projects.length === 1 ? [projects[0].id] : []
  );
  // Each new token starts at the stricter choices.
  const [where, setWhere] = useState<'ssh' | 'anywhere'>('ssh');
  const [lifetime, setLifetime] = useState(DEFAULT_LIFETIME);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // In the store's order, and only those that still exist.
  const chosenProjectIds = projects
    .map((project) => project.id)
    .filter((projectId) => projectIds.includes(projectId));
  const ready = label.trim().length > 0 && chosenProjectIds.length > 0 && !pending;
  // Reaching this computer is a choice only while devices may reach it.
  const sshOnly = !localAccess || where !== 'anywhere';

  const toggleProject = (projectId: string, checked: boolean) =>
    setProjectIds((ids) =>
      checked ? [...ids, projectId] : ids.filter((candidate) => candidate !== projectId)
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      const created = await window.api.agentTokensCreate({
        label: label.trim(),
        projectIds: chosenProjectIds,
        lifetimeDays: (lifetime === NEVER ? null : Number(lifetime)) as AgentTokenLifetimeDays,
        sshOnly,
      });
      onCreated(created);
    } catch (err) {
      setError(ipcErrorMessage(err));
      setPending(false);
    }
  };

  return (
    <form
      className="space-y-3 rounded-lg border border-border/60 p-3"
      onSubmit={(event) => void submit(event)}
    >
      <div className="space-y-1">
        <label htmlFor={`${id}-name`} className="text-ui text-muted-foreground">
          Name
        </label>
        <Input
          id={`${id}-name`}
          value={label}
          maxLength={MAX_AGENT_TOKEN_LABEL_CHARS}
          placeholder="Chat bot"
          autoFocus
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>
      <fieldset className="space-y-1">
        <legend className="text-ui text-muted-foreground">Projects</legend>
        {projects.map((project) => (
          <label key={project.id} className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox
              checked={projectIds.includes(project.id)}
              onChange={(event) => toggleProject(project.id, event.target.checked)}
            />
            <span className="truncate">{project.name}</span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-3">
        {localAccess && (
          <div className="space-y-1">
            <label htmlFor={`${id}-where`} className="block text-ui text-muted-foreground">
              Where
            </label>
            <Select
              id={`${id}-where`}
              value={where}
              className="w-56"
              onChange={(event) => setWhere(event.target.value as 'ssh' | 'anywhere')}
            >
              <option value="ssh">SSH hosts only</option>
              <option value="anywhere">SSH hosts and this computer</option>
            </Select>
          </div>
        )}
        <div className="space-y-1">
          <label htmlFor={`${id}-lifetime`} className="block text-ui text-muted-foreground">
            Works for
          </label>
          <Select
            id={`${id}-lifetime`}
            value={lifetime}
            className="w-40"
            onChange={(event) => setLifetime(event.target.value)}
          >
            {AGENT_TOKEN_LIFETIME_DAYS.map((days) => (
              <option key={String(days)} value={days === null ? NEVER : String(days)}>
                {days === null ? 'Never expires' : `${days} days`}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {sshOnly && !agentSshHostId && <SshHostNeededWarning />}
      {lifetime === NEVER && (
        <p className="text-ui text-warning">
          Anyone who copies this token can start agents in these projects until you revoke it.
        </p>
      )}
      {error && <p className="text-ui text-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready}>
          Approve
        </Button>
      </div>
    </form>
  );
}
