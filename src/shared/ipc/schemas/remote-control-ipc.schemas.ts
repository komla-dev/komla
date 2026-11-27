import { z } from 'zod';

import { AGENT_TOKEN_LIFETIME_DAYS, MAX_AGENT_TOKEN_LABEL_CHARS } from '../../types/agent-token';

export const remoteControlDisconnectActiveArgsSchema = z.tuple([z.literal('direct')]);

export const remoteControlDirectStartArgsSchema = z.tuple([
  z.strictObject({ publicOrigin: z.string().trim().min(1).max(2048).optional() }).optional(),
]);

export const remoteControlHostAccessSetArgsSchema = z.tuple([
  z.strictObject({ hostId: z.string().min(1).max(128), enabled: z.boolean() }),
]);

const credentialIdSchema = z.string().min(1).max(1024);

export const pairedDevicesRenameArgsSchema = z.tuple([
  z.strictObject({ credentialId: credentialIdSchema, label: z.string().min(1).max(120) }),
]);

export const agentTokensRevokeArgsSchema = z.tuple([
  z.strictObject({ id: z.string().min(1).max(128) }),
]);

/**
 * The same bounds as the remote control page's create frame; the service checks the rest, so both
 * approvals meet the same rules.
 */
export const agentTokensCreateArgsSchema = z.tuple([
  z.strictObject({
    label: z.string().min(1).max(MAX_AGENT_TOKEN_LABEL_CHARS),
    projectIds: z.array(z.string().min(1).max(128)).min(1).max(256),
    lifetimeDays: z.union(AGENT_TOKEN_LIFETIME_DAYS.map((days) => z.literal(days))),
    sshOnly: z.boolean(),
  }),
]);

export const pairedDevicesRemoveArgsSchema = z.tuple([
  z.strictObject({ credentialId: credentialIdSchema }),
]);
