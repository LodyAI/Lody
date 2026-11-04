import type { Meta, StoryObj } from '@storybook/react';
import type { WorkspaceId } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';
import { RecoveryPage } from '@/components/blocking-wait-placeholder';
import { recordBootRequestResult } from '@/lib/boot-request-failures';
import type { WorkspaceDataScopeObservation } from '@/hooks/use-workspace-data-scope-state';

const runtime = {
  workspaceSlug: 'acme',
  workspaceId: 'ws-acme' as WorkspaceId,
} as WorkspaceRuntime;

function observation(
  scope: 'doc_meta_scan_failed' | 'doc_meta_scan_pending'
): WorkspaceDataScopeObservation {
  return {
    targetSlug: 'acme',
    scope: { status: 'switching', targetSlug: 'acme', blocker: scope },
    workspaceId: runtime.workspaceId,
    organizationsReady: true,
    docMetaScanErrorType: scope === 'doc_meta_scan_failed' ? 'UnknownError' : null,
    runtimeInitErrorType: null,
  };
}

const meta: Meta<typeof RecoveryPage> = {
  title: 'Components/BlockingWaitRecovery',
  component: RecoveryPage,
  args: {
    layout: 'pane',
    gate: 'workspace_data',
    failed: true,
    observation: observation('doc_meta_scan_failed'),
    waitStartedAt: Date.now() - 4_000,
  },
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ height: '100dvh' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof RecoveryPage>;

/** The local copy could not be read, and today's automatic repair already ran. */
export const Failed: Story = {};

/** Nothing failed, but the workspace has not opened after the recovery delay. */
export const Slow: Story = {
  args: {
    failed: false,
    observation: observation('doc_meta_scan_pending'),
    waitStartedAt: Date.now() - 20_000,
  },
};

/** Before any workspace layout exists: the page is the whole window. */
export const FailedAtBoot: Story = {
  args: { layout: 'window' },
};

/** A wait outside any workspace (signing in, loading the workspace list). */
export const SlowBeforeAnyWorkspace: Story = {
  args: {
    layout: 'window',
    gate: 'session_loading',
    failed: false,
    observation: {
      targetSlug: null,
      scope: null,
      workspaceId: null,
      organizationsReady: false,
      docMetaScanErrorType: null,
      runtimeInitErrorType: null,
    },
  },
};

/** Stuck signing in because the session check keeps getting a server error. */
export const ServerErrorWhileSigningIn: Story = {
  args: SlowBeforeAnyWorkspace.args,
  decorators: [
    (Story) => {
      recordBootRequestResult('session', {
        status: 503,
        code: 'FAILED_TO_GET_SESSION',
        message: 'Failed to get session',
      });
      return <Story />;
    },
  ],
};
