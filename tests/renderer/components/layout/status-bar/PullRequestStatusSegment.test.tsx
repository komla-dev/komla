/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PullRequestStatusSegment } from '../../../../../src/renderer/components/layout/status-bar/PullRequestStatusSegment';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import { useConfigStore } from '../../../../../src/renderer/stores/config.store';
import { useWorkspaceObservationStore } from '../../../../../src/renderer/stores/workspace-observation.store';
import { useWorkspacesStore } from '../../../../../src/renderer/stores/workspaces.store';
import { createConfig, createWorkspace } from '../../../../factories';

import type {
  PullRequestStatus,
  PullRequestSummary,
} from '../../../../../src/shared/types/pull-request';

const pullRequest: PullRequestSummary = {
  number: 12,
  title: 'Add search',
  url: 'https://github.com/acme/app/pull/12',
  state: 'open',
  ci: 'failed',
  checks: [
    { name: 'CI / lint', state: 'passed', url: 'https://github.com/acme/app/runs/1' },
    { name: 'CI / test', state: 'failed', url: 'https://github.com/acme/app/runs/2' },
    { name: 'deploy', state: 'pending' },
  ],
};

let status: PullRequestStatus;
const getWorkspacePullRequestStatus = vi.fn(async () => status);
const openExternal = vi.fn();
const updateConfig = vi.fn();

async function renderSegment() {
  render(
    <TooltipProvider>
      <PullRequestStatusSegment />
    </TooltipProvider>
  );
  // The first read lands.
  await act(async () => {});
}

describe('PullRequestStatusSegment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    status = { kind: 'pull-request', pullRequest };
    Object.assign(window, { api: { getWorkspacePullRequestStatus, openExternal } });
    useWorkspacesStore.setState({
      workspaces: [createWorkspace({ id: 'ws-1', isWorktree: true })],
      selectedWorkspaceId: 'ws-1',
    });
    useWorkspaceObservationStore.setState({ projections: new Map() });
    useConfigStore.setState({ config: createConfig(), updateConfig });
  });

  it("shows the branch's pull request and how its checks stand", async () => {
    await renderSegment();

    expect(getWorkspacePullRequestStatus).toHaveBeenCalledWith('ws-1');
    expect(
      screen.getByRole('button', { name: 'Pull request: #12 Add search · CI failed' })
    ).toHaveTextContent('#12');
  });

  it('lists the checks, failed first, each opening on GitHub, and opens the pull request', async () => {
    const user = userEvent.setup();
    await renderSegment();

    await user.click(screen.getByRole('button', { name: /^Pull request:/ }));
    const checks = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(checks).toEqual(['CI / testfailed', 'deploypending', 'CI / lintpassed']);
    expect(screen.getByText('#12 · Open · 1 of 3 checks passed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /CI \/ test/ }));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/app/runs/2');
    await user.click(screen.getByRole('button', { name: 'Open on GitHub' }));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/app/pull/12');
  });

  it('turns off the notification when CI finishes', async () => {
    const user = userEvent.setup();
    await renderSegment();

    await user.click(screen.getByRole('button', { name: /^Pull request:/ }));
    const toggle = screen.getByRole('switch', { name: 'Notify when CI finishes' });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(updateConfig).toHaveBeenCalledWith({ pullRequestCiNotifications: false });
  });

  it('shows nothing for a branch without a pull request', async () => {
    status = { kind: 'none' };
    await renderSegment();

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/pull request/i)).not.toBeInTheDocument();
  });

  it('says what to do when gh is signed out', async () => {
    status = { kind: 'unavailable', reason: 'signed-out' };
    await renderSegment();

    expect(
      screen.getByLabelText('Run gh auth login to see this branch’s pull request')
    ).toBeInTheDocument();
  });

  it('shows nothing without gh, since the item is on by default', async () => {
    status = { kind: 'unavailable', reason: 'no-gh' };
    await renderSegment();

    expect(screen.queryByLabelText(/pull request/i)).not.toBeInTheDocument();
  });

  it('shows nothing when gh fails to read the pull request', async () => {
    status = {
      kind: 'unavailable',
      reason: 'error',
      message: "GraphQL: The 'acme' organization forbids access via a fine-grained token",
    };
    await renderSegment();

    expect(screen.queryByLabelText(/pull request/i)).not.toBeInTheDocument();
  });

  it('keeps showing the pull request when a later read fails', async () => {
    await renderSegment();
    status = { kind: 'unavailable', reason: 'error', message: 'The SSH host is not connected' };
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(getWorkspacePullRequestStatus).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole('button', { name: 'Pull request: #12 Add search · CI failed' })
    ).toBeInTheDocument();
  });

  it('hides the pull request once reads have failed for a couple of minutes', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    await renderSegment();
    status = { kind: 'unavailable', reason: 'error', message: 'token expired' };
    const readAt = async (at: number) => {
      now.mockReturnValue(at);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    };

    // However often it's asked within them, as gh's answer is shared for a few seconds.
    for (let read = 0; read < 5; read++) await readAt(1_000);
    await readAt(119_000);
    expect(screen.getByText('#12')).toBeInTheDocument();

    await readAt(120_000);
    expect(screen.queryByLabelText(/pull request/i)).not.toBeInTheDocument();
    now.mockRestore();
  });

  it("doesn't show one branch's pull request for another whose read failed", async () => {
    const onBranch = (currentBranch: string) =>
      act(() => {
        useWorkspaceObservationStore.setState({
          projections: new Map([
            ['ws-1', { branch: { currentBranch, hasRemote: true, unpushedCommits: 0 } } as never],
          ]),
        });
      });
    onBranch('feature-a');
    await renderSegment();
    expect(screen.getByText('#12')).toBeInTheDocument();

    status = { kind: 'unavailable', reason: 'error', message: 'The SSH host is not connected' };
    onBranch('feature-b');
    await act(async () => {});

    expect(getWorkspacePullRequestStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText(/pull request/i)).not.toBeInTheDocument();
  });

  it('reads again when the branch is pushed, not when its files change', async () => {
    const observe = (repositoryRevision: number, unpushedCommits: number) =>
      act(() => {
        useWorkspaceObservationStore.setState({
          projections: new Map([
            [
              'ws-1',
              {
                repositoryRevision,
                branch: { currentBranch: 'feature', hasRemote: true, unpushedCommits },
              } as never,
            ],
          ]),
        });
      });
    observe(1, 1);
    await renderSegment();

    observe(2, 1);
    observe(3, 1);
    await act(async () => {});
    expect(getWorkspacePullRequestStatus).toHaveBeenCalledTimes(1);

    observe(4, 0);
    await act(async () => {});
    expect(getWorkspacePullRequestStatus).toHaveBeenCalledTimes(2);
  });
});
