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
it run a fixed set of Komla Operations, limited to the projects the user chose. As on the
CLI and in the SDK, the operations own every rule, and Agent Capability controls still apply. The
route is only another adapter.

- **Pairing.** In the remote web app's Settings, under Agent access, a signed-in device names the
  agent, picks its projects, where it may work and how long the token works, and approves. Where
  starts at SSH hosts only; letting the agent reach this computer too is a choice the user makes
  for each token. A token works for 7, 30 or 90 days, 30 by default, so one forgotten in a bot's
  config stops working by itself. For a bot the user runs for good, it can instead work until
  revoked, and the form warns that anyone who copies it keeps that access. The desktop sends the
  token once, over the encrypted session, for the user to paste into the agent. A session needs no fresh passkey for this: it can already type into every terminal, which is
  more than a token allows. Every token is 256 random bits, and the desktop stores only its hash.
  Later, the route can follow the MCP authorization spec, OAuth 2.1 with PKCE and the desktop as its
  authorization server, with the same page as its consent screen, so clients that support it pair
  without a pasted token.
- **What a token may do.** It may run `agent.launch` into a new workspace, only in its projects,
  and `project.list` and `workspace.list`, limited to them. It can't send terminal input, read
  terminal output, attach a terminal or change settings. A prompt can still make an agent do
  anything that agent's mode allows, so a token starts only the modes the user lets agents start,
  the setting that already limits agents in Komla's terminals, and agents can't start a mode that
  skips permission prompts unless the user allowed it. A token for SSH hosts only, and every token
  while "Allow access to this computer" is off, neither sees nor starts workspaces on this
  computer, as devices may not then. A user who keeps that access for their own phone can still
  keep a bot off this computer.
- **New tools that take a project.** An outside agent has no `cwd`, so the route offers its own
  tools: `list_projects`, `list_workspaces`, `launch_workspace` (with project, prompt, and optional
  agent, mode, name and branch) and `workspace_status`. The existing tools stay as they are for
  agents in Komla's terminals. Listing projects is a new read-only operation, `project.list`,
  because before it only a failed launch listed them.
- **Transport.** Requests are plain HTTPS with a bearer token, not the encrypted Peer protocol that
  phones speak. MCP clients can't speak that protocol, and a token can't open a shell. Tailscale
  Serve ends TLS on the desktop's own machine, so the path stays encrypted all the way there. The
  route refuses requests that carry a browser `Origin` or a `Sec-Fetch-Site` other than `none`.
- **Tailnet only.** The Funnel rule is unchanged: Komla doesn't run remote control while Funnel is
  on for its port. An outside agent therefore has to run on a machine on the user's tailnet.
- **Revocation and audit.** Settings › Remote lists agent tokens next to trusted passkeys, with
  their scope and when each was last used. Removing one ends it at once. Removing the passkey that
  approved a token, or turning remote control off, revokes it too. Later, a workspace an outside
  agent launches can record which token launched it.
- **The desktop approves tokens too** (amended 2026-11). Settings › Remote's Agent access offers the
  same form, and the desktop approves through the same service and checks, since it is Komla
  itself and needs no passkey. "SSH hosts and this computer" is offered only while "Allow access
  to this computer" is on. The desktop shows the token once and still stores only its hash. Such a
  token belongs to the desktop, not a passkey: removing passkeys leaves it, while revoking it,
  expiry and turning remote control off end it as they end the rest. Each stored token records
  which approved it, a passkey by its credential id or the desktop, rather than borrowing a passkey
  id. A passkey's token is stored as before, so a Komla from before this change still reads it; such
  a build drops the desktop's tokens.
- **The desktop first.** The route runs on the desktop, so it is unavailable while the desktop is
  asleep. The host's phone server (ADR 0005) can already create workspaces without a desktop. It
  could later serve the same route, with token hashes and scopes copied to `trust.json` under its
  lease. That is a later decision.
- **The Where-agents-start host serves the route too** (amended 2026-11). A bot should keep
  starting workspaces while the laptop is shut, and agents already start on that host. Its phone
  server (ADR 0005) answers `/remote/mcp` on its own Tailscale Serve port with the same four tools;
  the desktop's tests hold the host's tool list to its own. The desktop writes each live token's
  hash, projects and expiry, never its label or the token, into that host's `trust.json`, and
  into no other host's, and writes what Outside Agents may start there into `launch.json`: each
  agent's modes that agents may start where the host is, isolated or not, and the agent and mode
  pinned for agent launches, worked out by the rules the desktop's operations use, so the host
  doesn't keep its own copy of them. The host sees a token's projects by their folders on it,
  lists only workspaces cut there, leaving out a project whose folder another shares, and starts
  workspaces through the code a phone uses. A tightened launch rule reaches a connected host at
  once, like a revoke.
  Revocation is bounded by the phones' 7-day lease: a revoke, a new token or a changed Where agents
  start reaches the host at once when Komla can connect to it, and otherwise the next time it does,
  and the host stops taking every token when the lease runs out. Settings › Remote gives a token
  limited to SSH hosts the host's address; the desktop's keeps working. A token's last use there
  isn't recorded. Phones still reach the host as before, through the page their browser cached
  from the desktop; serving that page from the host would need passkeys bound to the host's name,
  which is a later decision.

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
