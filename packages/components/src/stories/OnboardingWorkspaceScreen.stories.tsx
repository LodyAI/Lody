import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState } from 'react';
import { fn } from 'storybook/test';
import {
  OnboardingBackdrop,
  WorkspaceScreenView,
  type WorkspaceListEntry,
} from '@/components/onboarding';
import { generateWorkspaceSlug, normalizeWorkspaceSlugInput } from '@/lib/workspace';

function WorkspacePreviewWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-[760px] w-full">
      <OnboardingBackdrop />
      <div className="relative z-10 flex min-h-[760px] items-center justify-center p-8">
        {children}
      </div>
    </div>
  );
}

const sampleWorkspaces: WorkspaceListEntry[] = [
  { id: 'org_personal', name: "alex's workspace", slug: 'alex' },
  { id: 'org_loro', name: 'Loro Lab', slug: 'loro' },
  { id: 'org_consulting', name: 'Consulting Co', slug: 'consulting-co' },
];

const manyWorkspaces: WorkspaceListEntry[] = Array.from({ length: 8 }, (_, i) => ({
  id: `org_${i}`,
  name: `Team ${i}`,
  slug: `team-${i}`,
}));

/** Self-contained interactive story so picking a workspace + creating works. */
function InteractiveWorkspaceScreen({
  initialWorkspaces,
}: {
  initialWorkspaces: WorkspaceListEntry[];
}) {
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [selectedId, setSelectedId] = useState<string | null>(initialWorkspaces[0]?.id ?? null);
  const [creating, setCreating] = useState(initialWorkspaces.length === 0);
  const [newName, setNewName] = useState('');
  const [manuallyEditedSlug, setManuallyEditedSlug] = useState(false);
  const [manualSlug, setManualSlug] = useState('');
  const [saving, setSaving] = useState(false);

  const suggestedSlug = useMemo(() => generateWorkspaceSlug(newName), [newName]);
  const newSlug = manuallyEditedSlug ? manualSlug : suggestedSlug;

  return (
    <WorkspaceScreenView
      workspaces={workspaces}
      selectedWorkspaceId={selectedId}
      creating={creating}
      repairingWorkspaceName={null}
      onStartCreate={() => setCreating(true)}
      onStartRepair={fn()}
      onCancelCreate={() => setCreating(false)}
      newName={newName}
      newSlug={newSlug}
      newSlugChecking={false}
      newSlugAvailable
      newSlugCheckSlow={false}
      newSlugCheckError={null}
      newSlugError={null}
      canResetSlug={manuallyEditedSlug && newSlug !== suggestedSlug}
      onNewNameChange={setNewName}
      onNewSlugChange={(next) => {
        setManuallyEditedSlug(true);
        setManualSlug(normalizeWorkspaceSlugInput(next));
      }}
      onResetNewSlug={() => {
        setManuallyEditedSlug(false);
        setManualSlug(suggestedSlug);
      }}
      onRetryNewSlugCheck={fn()}
      saving={saving}
      writePending={saving}
      createError={null}
      workspacesStatus="ready"
      workspacesError={null}
      retryingWorkspaces={false}
      onRetryWorkspaces={fn()}
      onSelectWorkspace={setSelectedId}
      onConfirmSelection={() => {
        if (selectedId === null) return;
        setSaving(true);
        window.setTimeout(() => setSaving(false), 400);
      }}
      onSubmitCreate={() => {
        setSaving(true);
        window.setTimeout(() => {
          const id = `org_${Date.now()}`;
          setWorkspaces((prev) => [...prev, { id, name: newName, slug: newSlug }]);
          setSelectedId(id);
          setCreating(false);
          setNewName('');
          setManuallyEditedSlug(false);
          setManualSlug('');
          setSaving(false);
        }, 600);
      }}
      onBack={fn()}
    />
  );
}

const meta = {
  title: 'Onboarding/WorkspaceScreen',
  component: WorkspaceScreenView,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    createError: null,
    workspacesStatus: 'ready',
    workspacesError: null,
    retryingWorkspaces: false,
    onRetryWorkspaces: fn(),
    repairingWorkspaceName: null,
    onStartRepair: fn(),
    newSlugAvailable: true,
    newSlugCheckSlow: false,
    newSlugCheckError: null,
    onRetryNewSlugCheck: fn(),
    writePending: false,
    onStartCreate: fn(),
    onCancelCreate: fn(),
    onNewNameChange: fn(),
    onNewSlugChange: fn(),
    onResetNewSlug: fn(),
    onSelectWorkspace: fn(),
    onConfirmSelection: fn(),
    onSubmitCreate: fn(),
    onBack: fn(),
  },
  decorators: [
    (Story) => (
      <WorkspacePreviewWrapper>
        <Story />
      </WorkspacePreviewWrapper>
    ),
  ],
} satisfies Meta<typeof WorkspaceScreenView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleWorkspace: Story = {
  args: {
    workspaces: [sampleWorkspaces[0]!],
    selectedWorkspaceId: sampleWorkspaces[0]!.id,
    creating: false,
    newName: '',
    newSlug: '',
    newSlugChecking: false,
    newSlugError: null,
    canResetSlug: false,
    saving: false,
    writePending: false,
  },
};

export const MultipleWorkspaces: Story = {
  args: {
    workspaces: sampleWorkspaces,
    selectedWorkspaceId: sampleWorkspaces[1]!.id,
    creating: false,
    newName: '',
    newSlug: '',
    newSlugChecking: false,
    newSlugError: null,
    canResetSlug: false,
    saving: false,
  },
};

export const ManyWorkspacesScrolls: Story = {
  args: {
    workspaces: manyWorkspaces,
    selectedWorkspaceId: manyWorkspaces[0]!.id,
    creating: false,
    newName: '',
    newSlug: '',
    newSlugChecking: false,
    newSlugError: null,
    canResetSlug: false,
    saving: false,
  },
};

export const Empty: Story = {
  args: {
    workspaces: [],
    selectedWorkspaceId: null,
    creating: true,
    newName: '',
    newSlug: '',
    newSlugChecking: false,
    newSlugError: null,
    canResetSlug: false,
    saving: false,
  },
};

export const CreateForm: Story = {
  args: {
    workspaces: sampleWorkspaces,
    selectedWorkspaceId: sampleWorkspaces[0]!.id,
    creating: true,
    newName: 'Loro Lab',
    newSlug: 'loro-lab',
    newSlugChecking: false,
    newSlugError: null,
    canResetSlug: false,
    saving: false,
  },
};

export const SlugChecking: Story = {
  args: {
    workspaces: sampleWorkspaces,
    selectedWorkspaceId: sampleWorkspaces[0]!.id,
    creating: true,
    newName: 'Loro Lab',
    newSlug: 'loro-lab',
    newSlugChecking: true,
    newSlugError: null,
    canResetSlug: true,
    saving: false,
  },
};

export const SlugCheckingSlow: Story = {
  args: {
    workspaces: sampleWorkspaces,
    selectedWorkspaceId: sampleWorkspaces[0]!.id,
    creating: true,
    newName: 'Loro Lab',
    newSlug: 'loro-lab',
    newSlugChecking: true,
    newSlugCheckSlow: true,
    newSlugError: null,
    canResetSlug: true,
    saving: false,
  },
};

export const SlugCheckFailed: Story = {
  args: {
    workspaces: sampleWorkspaces,
    selectedWorkspaceId: sampleWorkspaces[0]!.id,
    creating: true,
    newName: 'Loro Lab',
    newSlug: 'loro-lab',
    newSlugChecking: false,
    newSlugAvailable: false,
    newSlugCheckError: 'network connection unavailable',
    newSlugError: null,
    canResetSlug: true,
    saving: false,
  },
};

export const MissingHandle: Story = {
  args: {
    workspaces: [{ id: 'org_legacy', name: 'Legacy Workspace', slug: '' }],
    selectedWorkspaceId: null,
    creating: false,
    newName: '',
    newSlug: '',
    newSlugChecking: false,
    newSlugAvailable: false,
    newSlugError: null,
    canResetSlug: false,
    saving: false,
  },
};

export const RepairHandle: Story = {
  args: {
    workspaces: [{ id: 'org_legacy', name: 'Legacy Workspace', slug: '' }],
    selectedWorkspaceId: null,
    creating: true,
    repairingWorkspaceName: 'Legacy Workspace',
    newName: 'Legacy Workspace',
    newSlug: 'legacy-workspace',
    newSlugChecking: false,
    newSlugAvailable: true,
    newSlugError: null,
    canResetSlug: false,
    saving: false,
  },
};

export const SlugUnavailable: Story = {
  args: {
    workspaces: sampleWorkspaces,
    selectedWorkspaceId: sampleWorkspaces[0]!.id,
    creating: true,
    newName: 'Loro Lab',
    newSlug: 'loro-lab',
    newSlugChecking: false,
    newSlugError: 'unavailable',
    canResetSlug: true,
    saving: false,
  },
};

export const Saving: Story = {
  args: {
    workspaces: sampleWorkspaces,
    selectedWorkspaceId: sampleWorkspaces[0]!.id,
    creating: true,
    newName: 'Loro Lab',
    newSlug: 'loro-lab',
    newSlugChecking: false,
    newSlugError: null,
    canResetSlug: false,
    saving: true,
    writePending: true,
  },
};

export const Loading: Story = {
  args: {
    workspaces: [],
    selectedWorkspaceId: null,
    creating: false,
    newName: '',
    newSlug: '',
    newSlugChecking: false,
    newSlugError: null,
    canResetSlug: false,
    saving: false,
    workspacesStatus: 'loading',
  },
};

export const LoadFailed: Story = {
  args: {
    workspaces: [],
    selectedWorkspaceId: null,
    creating: false,
    newName: '',
    newSlug: '',
    newSlugChecking: false,
    newSlugError: null,
    canResetSlug: false,
    saving: false,
    workspacesStatus: 'error',
    workspacesError: 'network request failed',
  },
};

export const CreateFailed: Story = {
  args: {
    workspaces: [],
    selectedWorkspaceId: null,
    creating: true,
    newName: 'Loro Lab',
    newSlug: 'loro-lab',
    newSlugChecking: false,
    newSlugError: null,
    canResetSlug: false,
    saving: false,
    createError: 'rate limited: too many workspaces created this hour',
  },
};

export const Interactive: Story = {
  args: {
    workspaces: sampleWorkspaces,
    selectedWorkspaceId: sampleWorkspaces[0]!.id,
    creating: false,
    newName: '',
    newSlug: '',
    newSlugChecking: false,
    newSlugError: null,
    canResetSlug: false,
    saving: false,
  },
  render: () => <InteractiveWorkspaceScreen initialWorkspaces={sampleWorkspaces} />,
};

export const InteractiveEmpty: Story = {
  args: {
    workspaces: [],
    selectedWorkspaceId: null,
    creating: true,
    newName: '',
    newSlug: '',
    newSlugChecking: false,
    newSlugError: null,
    canResetSlug: false,
    saving: false,
  },
  render: () => <InteractiveWorkspaceScreen initialWorkspaces={[]} />,
};
