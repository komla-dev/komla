import { Copy, Robot, Trash } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { IconButton } from '@/components/ui/icon-button';
import { useConfigStore } from '@/stores/config.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';

import { SettingsCard } from './SettingsCard';

import type { AgentTokenSummary } from '../../../../shared/types/agent-token';

const DAY_MS = 24 * 60 * 60_000;

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

/**
 * Settings › Remote's list of Agent Tokens. They are made on the remote control page, signed in
 * with a passkey, so this card only shows and revokes them, and gives the address they call.
 */
export function RemoteAgentTokensCard({ mcpUrl }: { mcpUrl: string | null }) {
  const tokens = useAgentTokens();
  const projects = useProjectsStore((s) => s.projects);
  const addToast = useToastStore((s) => s.addToast);
  const agentSshHostId = useConfigStore((s) => s.config?.agentLaunchDefaultSshHostId);

  if (tokens.length === 0) return null;
  // Agents start on this computer until Where agents start names an SSH host, so an SSH-only
  // token could start nothing.
  const sshOnlyStuck = !agentSshHostId && tokens.some((token) => token.sshOnly);

  const projectNames = (ids: string[]) =>
    ids.map((id) => projects.find((project) => project.id === id)?.name ?? 'Removed project');

  const revoke = async (token: AgentTokenSummary) => {
    if (!window.confirm(`Revoke "${token.label}"? It stops working at once.`)) return;
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
      description="Agents on your tailnet that start workspaces with a token you approved on the remote control page."
      action={
        mcpUrl ? (
          <IconButton
            label="Copy MCP address"
            size="md"
            onClick={() => {
              window.api.copyToClipboard(mcpUrl);
              addToast('MCP address copied', 'success');
            }}
          >
            <Copy className="size-3.5" />
          </IconButton>
        ) : undefined
      }
    >
      {sshOnlyStuck && (
        <p className="text-ui text-warning">
          Agents limited to SSH hosts can't start workspaces until you pick an SSH host under Where
          agents start in Settings › Integrations & MCP.
        </p>
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
