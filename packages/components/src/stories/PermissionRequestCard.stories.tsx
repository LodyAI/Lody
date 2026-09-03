import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  PermissionRequestCard,
  type PermissionOption,
} from '@/components/sessions/floating-permission-request';

const STANDARD_OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

const LONG_OPTIONS: PermissionOption[] = [
  {
    optionId: 'allow_once',
    name: 'Yes, run this command once',
    kind: 'allow_once',
  },
  {
    optionId: 'allow_always',
    name: 'Yes, and don\u2019t ask again for similar bash commands in this session',
    kind: 'allow_always',
  },
  {
    optionId: 'deny',
    name: 'No, and tell Claude what to do differently',
    kind: 'reject_once',
  },
];

const MANY_OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  {
    optionId: 'allow_always_cmd',
    name: 'Always allow this exact command',
    kind: 'allow_always',
  },
  {
    optionId: 'allow_always_tool',
    name: 'Always allow bash tool in this workspace',
    kind: 'allow_always',
  },
  { optionId: 'deny_once', name: 'Deny once', kind: 'reject_once' },
  {
    optionId: 'deny_always',
    name: 'Deny and stop the agent immediately',
    kind: 'reject_always',
  },
];

function InteractiveWrapper({ title, options }: { title?: string; options: PermissionOption[] }) {
  const [pendingOptionId, setPendingOptionId] = useState<string | null>(null);
  const [resolvedOptionId, setResolvedOptionId] = useState<string | null>(null);
  return (
    <PermissionRequestCard
      title={title}
      options={options}
      pendingOptionId={pendingOptionId}
      isResolved={resolvedOptionId !== null}
      selectedOptionId={resolvedOptionId}
      onSelect={(optionId) => {
        setPendingOptionId(optionId);
        setTimeout(() => {
          setPendingOptionId(null);
          setResolvedOptionId(optionId);
        }, 1200);
      }}
    />
  );
}

const meta = {
  title: 'Sessions/PermissionRequestCard',
  component: PermissionRequestCard,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  args: {
    options: STANDARD_OPTIONS,
    onSelect: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-[400px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PermissionRequestCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <InteractiveWrapper
      title="Run `pnpm install` to install project dependencies"
      options={STANDARD_OPTIONS}
    />
  ),
};

export const LongOptionLabels: Story = {
  render: () => (
    <InteractiveWrapper
      title={'Run `bash -lc \'find /workspace -name "*.ts" -exec grep -l permission {} +\'`'}
      options={LONG_OPTIONS}
    />
  ),
};

const LONG_COMMAND =
  'Run `bash -lc \'find /workspace -type f \\( -name "*.ts" -o -name "*.tsx" \\) -not -path "*/node_modules/*" -not -path "*/dist/*" -print0 | xargs -0 grep -l "permissionRequest" | xargs -I{} sh -c "echo === {} ===; sed -n 1,40p {}"\'`';

const VERY_LONG_COMMAND = `Run the following multi-step shell pipeline in the workspace root:

bash -lc '
  set -euo pipefail
  echo "Step 1: collecting TypeScript files..."
  mapfile -t files < <(find . -type f \\( -name "*.ts" -o -name "*.tsx" \\) -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.turbo/*")
  echo "Found \${#files[@]} files"

  echo "Step 2: extracting candidate matches..."
  for f in "\${files[@]}"; do
    if grep -nE "permissionRequest|requirePermission|ShieldCheck" "$f" > /dev/null; then
      printf "=== %s ===\\n" "$f"
      grep -nE "permissionRequest|requirePermission|ShieldCheck" "$f"
    fi
  done

  echo "Step 3: summarize..."
  echo "Done."
'`;

export const LongCommand: Story = {
  render: () => <InteractiveWrapper title={LONG_COMMAND} options={STANDARD_OPTIONS} />,
};

export const VeryLongCommand: Story = {
  render: () => <InteractiveWrapper title={VERY_LONG_COMMAND} options={STANDARD_OPTIONS} />,
};

export const ManyOptions: Story = {
  render: () => <InteractiveWrapper title="Edit file `src/app/main.ts`" options={MANY_OPTIONS} />,
};

export const NarrowContainer: Story = {
  render: () => (
    <div className="w-[260px] max-w-full">
      <InteractiveWrapper
        title="Read `apps/cli/src/lib/message-handler.ts`"
        options={LONG_OPTIONS}
      />
    </div>
  ),
};

export const WithoutTitle: Story = {
  render: () => <InteractiveWrapper options={STANDARD_OPTIONS} />,
};

export const ConversationCollapsed: Story = {
  args: {
    options: STANDARD_OPTIONS,
    defaultCollapsed: true,
    onSelect: () => {},
  },
};

export const Disabled: Story = {
  args: {
    title: 'Delete `node_modules`',
    options: STANDARD_OPTIONS,
    isReady: false,
    onSelect: () => {},
  },
};

export const Resolved: Story = {
  args: {
    title: 'Run `pnpm install` to install project dependencies',
    options: STANDARD_OPTIONS,
    isResolved: true,
    selectedOptionId: 'allow_once',
    onSelect: () => {},
  },
};

export const LoadingOption: Story = {
  args: {
    title: 'Run `pnpm install` to install project dependencies',
    options: STANDARD_OPTIONS,
    pendingOptionId: 'allow_once',
    onSelect: () => {},
  },
};
