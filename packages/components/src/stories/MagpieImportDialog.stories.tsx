import type { Meta, StoryObj } from '@storybook/react';
import type { MagpieTarget } from '@lody/shared';
import { userEvent, within } from 'storybook/test';
import {
  MagpieImportDialog,
  type MagpieImportOption,
} from '@/components/settings/magpie-import-dialog';

const NAMES: Record<MagpieTarget, string> = {
  claude: 'Claude-magpie',
  codex: 'Codex-magpie',
  pi: 'Pi-magpie',
  dsh: 'DSH-magpie',
};

function option(id: MagpieTarget, disabledReason?: string): MagpieImportOption {
  return disabledReason ? { id, name: NAMES[id], disabledReason } : { id, name: NAMES[id] };
}

const allOptions: MagpieImportOption[] = [
  option('claude'),
  option('codex'),
  option('pi'),
  option('dsh'),
];

const meta = {
  title: 'Settings/MagpieImportDialog',
  component: MagpieImportDialog,
  parameters: { layout: 'centered' },
  args: {
    open: true,
    onOpenChange: () => {},
    gatewayUrl: 'http://127.0.0.1:48723',
    machineName: 'Studio Mac',
    options: allOptions,
    onImport: async () => {},
  },
} satisfies Meta<typeof MagpieImportDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every runtime on this machine can be imported. All of them start selected. */
export const Ready: Story = {};

/** The link only offers some of the four runtimes. */
export const LinkSubset: Story = {
  args: {
    options: [option('claude'), option('dsh')],
  },
};

/** The local agent is still starting, so nothing can be imported yet. */
export const LocalAgentUnavailable: Story = {
  args: {
    options: allOptions.map((entry) => option(entry.id, 'Start the local agent to import Magpie.')),
  },
};

/** This machine's agent does not support Magpie import yet. */
export const UpdateRequired: Story = {
  args: {
    options: allOptions.map((entry) =>
      option(entry.id, 'Update the local agent to import Magpie.')
    ),
  },
};

/** Pi cannot be selected here. The other runtimes stay selected. */
export const PiUnsupported: Story = {
  args: {
    options: [
      option('claude'),
      option('codex'),
      option('pi', 'Pi is not supported on this machine.'),
      option('dsh'),
    ],
  },
};

/** Persistence failed. The dialog stays open with the selection intact. */
export const ImportFailed: Story = {
  args: {
    error:
      'Could not finish importing. Check the local agent and retry; providers already added will be kept.',
  },
};

/** The confirm button waits on the host callback and ignores another click. */
export const Submitting: Story = {
  args: {
    onImport: () => new Promise(() => {}),
  },
  play: async () => {
    const body = within(document.body);
    await userEvent.click(await body.findByRole('button', { name: 'Import' }));
  },
};

/** No machine name yet: the dialog still says the import is for this machine. */
export const UnnamedMachine: Story = {
  args: { machineName: undefined },
};

/** The request has no runtimes to offer. */
export const Empty: Story = {
  args: { options: [] },
};
