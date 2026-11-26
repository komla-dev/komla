// Settings › Agent access: Agent Tokens for Outside Agents (ADR 0013).
//
// A signed-in device approves a token for an agent on the user's tailnet, limited to the projects
// it picks, and sees it once to copy. The agent then calls `/remote/mcp` with it. Only the desktop
// keeps tokens, so the section shows only while this page is connected to the desktop.

import {
  MAX_REMOTE_AGENT_TOKEN_LABEL_CHARS,
  REMOTE_AGENT_TOKEN_LIFETIME_DAYS,
  type RemoteAgentTokenSummary,
  type RemoteAppFrame,
  type RemoteProjectSummary,
} from '@komla/remote-protocol';

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_LIFETIME_DAYS = 30;
const NEVER = 'never';

export interface AgentAccessElements {
  section: HTMLElement;
  list: HTMLElement;
  add: HTMLButtonElement;
  form: HTMLFormElement;
  label: HTMLInputElement;
  projects: HTMLElement;
  lifetime: HTMLSelectElement;
  /** Shown only while the token would never expire. */
  neverWarning: HTMLElement;
  /** `ssh` or `anywhere`. */
  where: HTMLSelectElement;
  approve: HTMLButtonElement;
  cancel: HTMLButtonElement;
  created: HTMLElement;
  token: HTMLElement;
  copyToken: HTMLButtonElement;
  mcpUrl: HTMLElement;
  copyMcpUrl: HTMLButtonElement;
  done: HTMLButtonElement;
  hint: HTMLElement;
}

type AgentAccessRequest =
  | { type: 'app:agent-tokens:list' }
  | { type: 'app:agent-token:revoke'; id: string }
  | Omit<Extract<RemoteAppFrame, { type: 'app:agent-token:create' }>, 'requestId'>;

export interface AgentAccessDeps {
  /** Sends a frame with a new request id; null when the page isn't connected. */
  send(frame: AgentAccessRequest): string | null;
  projects(): RemoteProjectSummary[];
  /** The page's own origin, which serves `/remote/mcp` too. */
  origin(): string;
  copy(text: string): Promise<void>;
  confirm(message: string): boolean;
  now?: () => number;
}

/** When a token stops working, and when its agent last called. */
export function agentTokenDetail(token: RemoteAgentTokenSummary, now: number): string {
  const where = token.sshOnly ? 'SSH hosts only' : 'SSH hosts and this computer';
  if (token.expiresAt !== null && token.expiresAt <= now) return `${where} · Expired`;
  const days =
    token.expiresAt === null ? 0 : Math.max(1, Math.ceil((token.expiresAt - now) / DAY_MS));
  const expires =
    token.expiresAt === null ? 'Never expires' : `Expires in ${days} day${days === 1 ? '' : 's'}`;
  if (!token.lastUsedAt) return `${where} · ${expires} · never used`;
  const used = new Date(token.lastUsedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${where} · ${expires} · used ${used}`;
}

export class AgentAccessPanel {
  private tokens: RemoteAgentTokenSummary[] = [];
  private available = false;
  /** A create or revoke on its way, which holds off another. */
  private pendingRequestId: string | null = null;
  private listRequestId: string | null = null;
  private note = '';
  private readonly now: () => number;

  constructor(
    private readonly els: AgentAccessElements,
    private readonly deps: AgentAccessDeps
  ) {
    this.now = deps.now ?? Date.now;
    els.label.maxLength = MAX_REMOTE_AGENT_TOKEN_LABEL_CHARS;
    els.lifetime.replaceChildren(
      ...REMOTE_AGENT_TOKEN_LIFETIME_DAYS.map((days) => {
        const option = document.createElement('option');
        option.value = days === null ? NEVER : String(days);
        option.textContent = days === null ? 'Never expires' : `${days} days`;
        option.selected = days === DEFAULT_LIFETIME_DAYS;
        return option;
      })
    );
    els.add.addEventListener('click', () => this.openForm());
    els.cancel.addEventListener('click', () => this.closeForm());
    els.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.approve();
    });
    els.form.addEventListener('input', () => this.renderForm());
    els.copyToken.addEventListener('click', () => this.copy(els.token.textContent ?? '', 'Token'));
    els.copyMcpUrl.addEventListener('click', () =>
      this.copy(els.mcpUrl.textContent ?? '', 'Address')
    );
    els.done.addEventListener('click', () => {
      // The token leaves the page once the user is done with it.
      els.token.textContent = '';
      els.created.hidden = true;
      this.render();
    });
  }

  /** Shown only while connected to the desktop, the one place tokens live. */
  connected(toDesktop: boolean): void {
    this.available = toDesktop;
    // A request sent before a reconnect gets no answer on the new session.
    this.pendingRequestId = null;
    this.refresh();
  }

  /** Asks the desktop for its tokens again, as when Settings opens: another device may have changed them. */
  refresh(): void {
    this.listRequestId = this.available
      ? this.deps.send({ type: 'app:agent-tokens:list' })
      : null;
    this.render();
  }

  /** Takes the frames meant for this section; false for any other. */
  handleFrame(frame: RemoteAppFrame): boolean {
    switch (frame.type) {
      case 'app:agent-tokens':
        if (frame.requestId === this.pendingRequestId) this.pendingRequestId = null;
        if (frame.requestId === this.listRequestId) this.listRequestId = null;
        this.tokens = frame.tokens;
        this.render();
        return true;
      case 'app:agent-token:created':
        if (frame.requestId !== this.pendingRequestId) return true;
        this.pendingRequestId = null;
        this.tokens = [frame.summary, ...this.tokens.filter(({ id }) => id !== frame.summary.id)];
        this.els.form.hidden = true;
        this.els.token.textContent = frame.token;
        this.els.mcpUrl.textContent = `${this.deps.origin()}/remote/mcp`;
        this.els.created.hidden = false;
        this.render();
        return true;
      case 'app:error':
        if (!frame.requestId) return false;
        if (frame.requestId === this.listRequestId) this.listRequestId = null;
        else if (frame.requestId === this.pendingRequestId) this.pendingRequestId = null;
        else return false;
        this.note = frame.message;
        this.render();
        return true;
      default:
        return false;
    }
  }

  private request(frame: AgentAccessRequest): void {
    this.note = '';
    this.pendingRequestId = this.deps.send(frame);
    if (!this.pendingRequestId) this.note = 'Not connected to Komla.';
  }

  private openForm(): void {
    this.els.created.hidden = true;
    this.els.form.hidden = false;
    this.els.label.value = '';
    // Each new token starts at the stricter choices.
    this.els.where.value = 'ssh';
    this.els.lifetime.value = String(DEFAULT_LIFETIME_DAYS);
    const projects = this.deps.projects();
    this.els.projects.replaceChildren(
      ...projects.map((project) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = project.id;
        // One project is the obvious choice when it's the only one.
        input.checked = projects.length === 1;
        const name = document.createElement('span');
        name.textContent = project.name;
        label.append(input, name);
        return label;
      })
    );
    this.render();
    this.els.label.focus();
  }

  private closeForm(): void {
    this.els.form.hidden = true;
    this.render();
  }

  private selectedProjectIds(): string[] {
    return [...this.els.projects.querySelectorAll<HTMLInputElement>('input:checked')].map(
      (input) => input.value
    );
  }

  private approve(): void {
    const label = this.els.label.value.trim();
    const projectIds = this.selectedProjectIds();
    if (!label || projectIds.length === 0) return;
    const lifetimeDays =
      this.els.lifetime.value === NEVER ? null : (Number(this.els.lifetime.value) as 7 | 30 | 90);
    const sshOnly = this.els.where.value !== 'anywhere';
    this.request({ type: 'app:agent-token:create', label, projectIds, lifetimeDays, sshOnly });
    this.render();
  }

  private revoke(token: RemoteAgentTokenSummary): void {
    if (!this.deps.confirm(`Revoke "${token.label}"? It stops working at once.`)) return;
    this.request({ type: 'app:agent-token:revoke', id: token.id });
    this.render();
  }

  private copy(text: string, what: string): void {
    if (!text) return;
    this.deps.copy(text).then(
      () => {
        this.note = `${what} copied.`;
        this.render();
      },
      () => {
        this.note = `Couldn't copy. Select the ${what.toLowerCase()} and copy it.`;
        this.render();
      }
    );
  }

  private renderForm(): void {
    this.els.neverWarning.hidden = this.els.lifetime.value !== NEVER;
    this.els.approve.disabled =
      this.pendingRequestId !== null ||
      !this.els.label.value.trim() ||
      this.selectedProjectIds().length === 0;
  }

  render(): void {
    this.els.section.hidden = !this.available;
    const projects = new Map(this.deps.projects().map((project) => [project.id, project.name]));
    const now = this.now();
    this.els.list.replaceChildren(
      ...this.tokens.map((token) => {
        const row = document.createElement('li');
        row.className = 'agent-token-row';
        const text = document.createElement('span');
        text.className = 'settings-text';
        const name = document.createElement('strong');
        name.textContent = token.label;
        const detail = document.createElement('small');
        const names = token.projectIds.map((id) => projects.get(id) ?? 'Removed project');
        detail.textContent = `${names.join(', ')} · ${agentTokenDetail(token, now)}`;
        text.append(name, detail);
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'agent-token-revoke';
        revoke.textContent = 'Revoke';
        revoke.setAttribute('aria-label', `Revoke ${token.label}`);
        revoke.disabled = this.pendingRequestId !== null;
        revoke.addEventListener('click', () => this.revoke(token));
        row.append(text, revoke);
        return row;
      })
    );
    this.els.list.hidden = this.tokens.length === 0;
    this.els.add.hidden = !this.els.form.hidden || !this.els.created.hidden;
    this.els.add.disabled = this.deps.projects().length === 0;
    this.renderForm();
    const hint =
      this.note ||
      (this.deps.projects().length === 0 ? 'Add a project in Komla to give an agent access.' : '');
    this.els.hint.textContent = hint;
    this.els.hint.hidden = !hint;
  }
}
