---
status: accepted
---

# Outside agents reach Komla over MCP through remote control, with tokens approved by passkey

Bots and agents that run outside Komla's terminals, such as a chat bot on another machine, can't
start workspaces. Komla's MCP server and HTTP API listen on 127.0.0.1, take no credentials and refuse
other hosts on purpose, and every MCP tool works out its project from the caller's `cwd`. The
workaround is to give the bot an SSH key to the host and have it run `komla launch` there. That
hands it a full shell, and with no desktop connected it can't choose the project or the agent.

Komla will instead serve MCP on the remote control server, at `/remote/mcp`, the same server that
Tailscale Serve already publishes to the tailnet. An **outside agent** gets an **agent token** that
the user approves on the remote control page while signed in with a trusted passkey. The token lets
it run a fixed set of Komla Operations, limited to the projects and agents the user chose. As on the
CLI and in the SDK, the operations own every rule, and Agent Capability controls still apply. The
route is only another adapter.

- **Pairing.** The route follows the MCP authorization spec: OAuth 2.1 with PKCE, and the desktop as
  its authorization server. A client that calls without a token gets `401` and the server's
  metadata. It sends the user to a consent page in the remote web app. The user signs in there with
  a passkey and user verification, as for any session, and sees the client's name. They choose
  which projects, agents and launch modes it may use, then approve. The desktop issues a
  short-lived access token and a rotating refresh token. A client that only takes a fixed header
  gets the same consent page, which shows a token to paste instead, valid for a period the user
  picks, at most 90 days. Every token is 256 random bits, and the desktop stores only its hash.
- **What a token may do.** It may run `agent.launch` into a new workspace, only in its projects and
  only with the agents and modes the user chose. It may also run `workspace.list`, limited to its
  projects, and read a workspace's state. It can't send terminal input, read terminal output, attach
  a terminal or change settings. A prompt can still make an agent do anything that agent's mode
  allows, which is why the consent page names the modes and offers none that skip permissions
  unless the user ticks them.
- **New tools that take a project.** An outside agent has no `cwd`, so the route offers its own
  tools: `list_projects`, `list_workspaces`, `launch_workspace` (with project, prompt, and optional
  agent, mode, name and branch) and `workspace_status`. The existing tools stay as they are for
  agents in Komla's terminals. Listing projects needs a new read-only operation, because today only
  a failed launch lists them.
- **Transport.** Requests are plain HTTPS with a bearer token, not the encrypted Peer protocol that
  phones speak. MCP clients can't speak that protocol, and a token can't open a shell. Tailscale
  Serve ends TLS on the desktop's own machine, so the path stays encrypted all the way there. The
  route refuses requests that carry a browser `Origin`. The consent pages are the only exception,
  and they are served from Komla's own origin.
- **Tailnet only.** The Funnel rule is unchanged: Komla doesn't run remote control while Funnel is
  on for its port. An outside agent therefore has to run on a machine on the user's tailnet.
- **Revocation and audit.** Settings › Remote lists agent tokens next to trusted passkeys, with
  their scope and when each was last used. Removing one ends it at once. Removing the passkey that
  approved a token, or turning remote control off, revokes it too. A workspace an outside agent
  launches records which token launched it.
- **The desktop first.** The route runs on the desktop, so it is unavailable while the desktop is
  asleep. The host's phone server (ADR 0005) can already create workspaces without a desktop. It
  could later serve the same route, with token hashes and scopes copied to `trust.json` under its
  lease. That is a later decision.

## Considered options

- **SSH key with a forced command running `komla launch`:** this works today and needs no change to
  Komla. It was rejected as the supported path because the key's scope is whatever a shell script
  enforces, every new bot needs its own key, and with no desktop connected the launch can't choose
  its project or agent. It remains a stopgap.
- **Publishing the local MCP server on the tailnet:** rejected. That server has no authentication,
  and its `Host` and `Origin` checks exist so that nothing beyond this computer can reach it.
- **A client library that speaks the Peer protocol:** rejected. Bots use ordinary MCP clients, and
  the protocol's passkey step needs a person at a browser on every sign-in.
- **Tailscale identity headers as the credential:** rejected. They name the tailnet user, so every
  process on that user's devices would look alike, and tagged devices, where bots often run, get
  none.
- **Tailscale Funnel, for bots in someone else's cloud:** rejected, because it would expose remote
  control to the internet, which the Funnel rule exists to prevent.

## Consequences

- An approved token is the first remote-control credential that works without a passkey on every
  sign-in. Its narrow scope is the security boundary, so new operations reach outside agents only
  when they are added to the token's scope list deliberately.
- `docs/REMOTE_CONTROL_SECURITY.md` and `docs/CLI.md` gain sections on agent tokens and the new
  tools. `GLOSSARY.md` defines **Outside Agent** and **Agent Token**.
