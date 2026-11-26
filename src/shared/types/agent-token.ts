/**
 * How long the user lets an Agent Token work, in days (ADR 0013), or null for a token that works
 * until it is revoked.
 */
export const AGENT_TOKEN_LIFETIME_DAYS = [7, 30, 90, null] as const;
export type AgentTokenLifetimeDays = (typeof AGENT_TOKEN_LIFETIME_DAYS)[number];

export const MAX_AGENT_TOKEN_LABEL_CHARS = 64;
export const MAX_AGENT_TOKENS = 32;

/** An Agent Token as Settings and the phone list it: never the token itself. */
export interface AgentTokenSummary {
  id: string;
  label: string;
  /** The projects the Outside Agent may list and start workspaces in. */
  projectIds: string[];
  /**
   * The Outside Agent sees and starts only workspaces on SSH hosts, never on this computer, whatever
   * "Allow access to this computer" says for devices.
   */
  sshOnly: boolean;
  /** Epoch ms. */
  createdAt: number;
  /** Null for a token that never expires. */
  expiresAt: number | null;
  lastUsedAt?: number;
}
