import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useRef, useState } from 'react';
import { Provider, createStore } from 'jotai';
import { I18nextProvider, useTranslation } from 'react-i18next';
import type { CloudApi } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { MobileCreateWorkspaceSheet } from '../components/mobile/mobile-create-workspace-sheet';
import { MobileDeleteWorkspaceSheet } from '../components/mobile/mobile-delete-workspace-sheet';
import { AuthenticatedConvexContext } from '../hooks/use-authenticated-convex';
import { TEST_CLOUD_PLATFORM } from '../../tests/test-platform';

const meta = {
  title: 'Components/OwnedMobileWorkspaceSheetsMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Mode = 'create' | 'blocked' | 'checking' | 'unavailable' | 'delete';

function Fixture({
  mode,
  long = false,
  warning = false,
}: {
  mode: Mode;
  long?: boolean;
  warning?: boolean;
}) {
  const { i18n } = useTranslation();
  const [store] = useState(createStore);
  const [open, setOpen] = useState(true);
  const [result, setResult] = useState('Ready');
  const [pending, setPending] = useState(false);
  const resolveRef = useRef<(() => void) | null>(null);
  const [translations] = useState(() => {
    const instance = i18n.cloneInstance({ lng: 'en', fallbackLng: 'en', forkResourceStore: true });
    if (long) {
      instance.addResourceBundle(
        'en',
        'translation',
        {
          'organization.createNewWorkspace': 'Create a new collaborative development workspace',
          'organization.createNewWorkspaceDescription':
            'Choose a descriptive workspace name for your team.\nThe workspace address remains visible when you share conversations and manage your projects.',
          'organization.workspaceName': 'Workspace display name for your development team',
          'organization.workspaceSlug': 'Unique workspace address',
          'workspace.danger.deleteWorkspace.confirmTitle':
            'Permanently delete this collaborative workspace?',
          'workspace.danger.deleteWorkspace.confirmDescription':
            'Permanently delete "{{workspace}}", including its conversations and project configuration. This destructive action cannot be undone.',
          'workspace.danger.deleteWorkspace.typeToConfirm':
            'Type the complete workspace name "{{workspace}}" to confirm permanent deletion',
        },
        true,
        true
      );
    }
    return instance;
  });
  useEffect(() => {
    const settle = () => resolveRef.current?.();
    window.addEventListener('mobile-workspace-fixture-settle', settle);
    return () => window.removeEventListener('mobile-workspace-fixture-settle', settle);
  }, []);
  const cloudApi: CloudApi = {
    useQuery: (operation, args) => {
      if (args === 'skip') return undefined;
      const value = operation.name.includes('getWorkspaceCreationAvailability')
        ? { canCreateFree: mode !== 'blocked' }
        : mode === 'checking'
          ? undefined
          : { available: mode !== 'unavailable' };
      return value as never;
    },
    useMutation: () => async () => {
      throw new Error('Unexpected fixture mutation');
    },
    useAction: () => async () => {
      throw new Error('Unexpected fixture action');
    },
  };
  const name = long
    ? 'Synthetic collaborative development workspace — international team'
    : 'Synthetic Workspace';
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    setResult(next ? 'Opened' : 'Closed');
  };
  return (
    <Provider store={store}>
      <PlatformContext.Provider value={{ ...TEST_CLOUD_PLATFORM, cloudApi }}>
        <AuthenticatedConvexContext.Provider
          value={{
            authSessionId: 'synthetic-workspace-fixture',
            isAuthenticated: true,
            isLoading: false,
            isRecovering: false,
            confirmedUnauthenticated: false,
            claimAutomaticCommand: () => false,
            requestAuthRecovery: () => {},
          }}
        >
          <I18nextProvider i18n={translations}>
            <main
              data-mobile-workspace-fixture={mode}
              data-mobile-workspace-long={long}
              style={{ minHeight: '100dvh', padding: 20 }}
            >
              <button
                type="button"
                data-mobile-workspace-reopen=""
                onClick={() => onOpenChange(true)}
              >
                Open {mode === 'delete' ? 'delete' : 'create'} workspace sheet
              </button>
              <output
                data-mobile-workspace-result=""
                data-pending={pending}
                style={{ display: 'block' }}
              >
                {result}
              </output>
              {mode === 'delete' ? (
                <MobileDeleteWorkspaceSheet
                  open={open}
                  onOpenChange={onOpenChange}
                  workspaceName={name}
                  warningText={
                    warning
                      ? 'Synthetic billing warning: outstanding usage charges and invoices remain payable after this workspace is deleted. Review the final invoice before continuing.'
                      : null
                  }
                  onConfirm={() => {
                    setPending(true);
                    setResult('Delete pending');
                    return new Promise<void>((resolve) => {
                      resolveRef.current = resolve;
                    }).then(() => {
                      setPending(false);
                      setResult('Delete completed');
                    });
                  }}
                />
              ) : (
                <MobileCreateWorkspaceSheet
                  open={open}
                  onOpenChange={onOpenChange}
                  onCreated={(slug) => setResult(`Created ${slug}`)}
                />
              )}
            </main>
          </I18nextProvider>
        </AuthenticatedConvexContext.Provider>
      </PlatformContext.Provider>
    </Provider>
  );
}

export const Create: Story = { render: () => <Fixture mode="create" /> };
export const CreateBlocked: Story = { render: () => <Fixture mode="blocked" /> };
export const CreateChecking: Story = { render: () => <Fixture mode="checking" /> };
export const CreateUnavailable: Story = { render: () => <Fixture mode="unavailable" /> };
export const CreateLongText: Story = { render: () => <Fixture mode="create" long /> };
export const Delete: Story = { render: () => <Fixture mode="delete" /> };
export const DeleteWarning: Story = { render: () => <Fixture mode="delete" warning /> };
export const DeleteLongText: Story = { render: () => <Fixture mode="delete" long warning /> };
