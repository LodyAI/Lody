import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { LocalProjectId, MachineId, ProjectMemberId } from '@lody/shared';
import {
  ProjectGroupForm,
  type ProjectGroupFormProps,
  type ProjectGroupMemberStatus,
} from '@/components/settings/project-group-form';
import type { ProjectMemberSourceOption } from '@/hooks/use-project-member-sources';
import {
  EMPTY_PROJECT_GROUP_FORM_VALUE,
  getProjectMemberSourceKey,
  validateProjectGroupForm,
  type ProjectGroupFormValue,
  type ProjectGroupMemberDraft,
} from '@/lib/project-group-form';

const sources: ProjectMemberSourceOption[] = [
  {
    key: 'local:machine-1:web',
    source: {
      kind: 'local',
      machineId: 'machine-1' as MachineId,
      localProjectId: 'web' as LocalProjectId,
    },
    label: 'web',
    detail: 'Studio',
    online: true,
  },
  {
    key: 'github:acme/api',
    source: { kind: 'github', repoFullName: 'acme/api' },
    label: 'acme/api',
    detail: 'Go backend',
  },
  {
    key: 'github:acme/proto',
    source: { kind: 'github', repoFullName: 'acme/proto' },
    label: 'acme/proto',
    detail: 'Shared interface definitions',
  },
  {
    key: 'local:machine-2:ios',
    source: {
      kind: 'local',
      machineId: 'machine-2' as MachineId,
      localProjectId: 'ios' as LocalProjectId,
    },
    label: 'ios',
    detail: 'Build box',
    online: true,
  },
  {
    key: 'github:acme/docs',
    source: { kind: 'github', repoFullName: 'acme/docs' },
    label: 'acme/docs',
  },
];

const member = (
  id: string,
  sourceIndex: number,
  placement: ProjectGroupMemberDraft['placement'],
  placementOrigin: ProjectGroupMemberDraft['placementOrigin'] = 'default'
): ProjectGroupMemberDraft => ({
  id: id as ProjectMemberId,
  source: sources[sourceIndex]!.source,
  placement,
  placementOrigin,
});

const shop: ProjectGroupFormValue = {
  name: 'Shop',
  instructions: '',
  members: [
    member('web', 0, { kind: 'root', dir: 'web' }),
    member('api', 1, { kind: 'root', dir: 'api' }),
    member(
      'proto',
      2,
      { kind: 'submodule', parent: 'api' as ProjectMemberId, path: 'proto' },
      'detected'
    ),
  ],
};

const byKey = new Map(sources.map((option) => [option.key, option]));

/** The dialog owns the value and its validation in the product; the story does here. */
function StatefulProjectGroupForm(
  props: Omit<ProjectGroupFormProps, 'validation' | 'labelOf' | 'detailOf' | 'statusOf'> & {
    statuses?: Record<string, ProjectGroupMemberStatus>;
  }
) {
  const [value, setValue] = useState(props.value);
  const validation = useMemo(() => validateProjectGroupForm(value), [value]);
  return (
    <ProjectGroupForm
      {...props}
      value={value}
      onChange={setValue}
      validation={validation}
      labelOf={(m) => byKey.get(getProjectMemberSourceKey(m.source))?.label ?? 'Unknown'}
      detailOf={(m) => byKey.get(getProjectMemberSourceKey(m.source))?.detail}
      statusOf={(id) => props.statuses?.[id]}
    />
  );
}

const meta = {
  title: 'Settings/ProjectGroupForm',
  component: StatefulProjectGroupForm,
  args: {
    value: shop,
    onChange: () => undefined,
    sources,
    onSubmit: () => undefined,
    onCancel: () => undefined,
  },
  decorators: [
    // Mirrors the settings dialog that hosts the form.
    (Story) => (
      <div className="mx-auto flex h-[620px] w-[620px] flex-col gap-4 overflow-hidden rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatefulProjectGroupForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewGroup: Story = { args: { value: EMPTY_PROJECT_GROUP_FORM_VALUE } };

/** `proto` was found in `api`'s `.gitmodules`, so it nests under `api/`. */
export const DetectedSubmodule: Story = {};

/** Detection still running for one member and impossible for another. */
export const DetectionStates: Story = {
  args: {
    value: {
      ...shop,
      members: [
        member('web', 0, { kind: 'root', dir: 'web' }),
        member('api', 1, { kind: 'root', dir: 'api' }),
        member('proto', 2, { kind: 'root', dir: 'proto' }),
      ],
    },
    statuses: { web: 'unavailable', api: 'pending' },
  },
};

/** Two members claim one directory; both rows carry the mark, the card says why. */
export const DuplicateDirectory: Story = {
  args: {
    value: {
      ...shop,
      members: [
        member('web', 0, { kind: 'root', dir: 'app' }),
        member('api', 1, { kind: 'root', dir: 'app' }),
      ],
    },
  },
};

export const WithInstructions: Story = {
  args: {
    value: {
      ...shop,
      instructions:
        'web is the Next.js frontend; api is the Go backend; proto holds the interfaces both share.',
    },
    isEditing: true,
  },
};

/** Someone else's group: visible, not editable. */
export const ReadOnly: Story = { args: { readOnly: true, isEditing: true } };

/** Submodules of submodules step in once per level, as they will on disk. */
export const NestedSubmodules: Story = {
  args: {
    value: {
      name: 'Lody',
      instructions: '',
      members: [
        member('api', 1, { kind: 'root', dir: 'api' }),
        member(
          'proto',
          2,
          { kind: 'submodule', parent: 'api' as ProjectMemberId, path: 'proto' },
          'detected'
        ),
        member(
          'docs',
          4,
          {
            kind: 'submodule',
            parent: 'proto' as ProjectMemberId,
            path: 'packages/acp-extension-docs',
          },
          'detected'
        ),
        member('web', 0, { kind: 'root', dir: 'web' }),
      ],
    },
  },
};
