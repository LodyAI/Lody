import { useLayoutEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { Button, Popover } from '@lody/ui';
import { space } from '@lody/ui/tokens/scales.stylex';
import { CompactNavigationDialog } from '@/components/compact-navigation-dialog';
import { Dialog } from '@/ui/dialog';
import { FocusScope } from '@/ui/focus-scope';
import { WORKSPACE_FOCUS_SCOPES } from '@/atoms/focus-layer';

const styles = stylex.create({
  shell: { position: 'relative', display: 'flex', height: '100dvh' },
  content: { flex: 1, padding: space[4] },
  sidebar: { display: 'flex', flexDirection: 'column', height: '100%', padding: space[4] },
  footer: { marginTop: 'auto' },
});

/** `closeOnMount` commits the dialog open and closes it before the first paint, as a
 * narrow window does while its compact layout state is still settling. */
function Harness({ closeOnMount = false }: { closeOnMount?: boolean }) {
  const [open, setOpen] = useState(closeOnMount);
  useLayoutEffect(() => {
    if (closeOnMount) setOpen(false);
  }, [closeOnMount]);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [machineOpen, setMachineOpen] = useState(false);
  const [removeOpener, setRemoveOpener] = useState(false);
  return (
    <div ref={setRoot} {...stylex.props(styles.shell)}>
      <CompactNavigationDialog
        open={open}
        onOpenChange={setOpen}
        container={root}
        returnFocus={returnFocus}
      >
        <FocusScope id="navigation" {...stylex.props(styles.sidebar)}>
          <Button onClick={() => setOpen(false)}>New Chat</Button>
          <Popover.Root>
            <Popover.Trigger render={<Button />}>Navigation machine</Popover.Trigger>
            <Popover.Content aria-label="Navigation machine picker">
              <Button>Demo machine</Button>
            </Popover.Content>
          </Popover.Root>
          <Button
            onClick={() => {
              setRemoveOpener(true);
              setOpen(false);
            }}
          >
            Remove opener and close
          </Button>
          <div {...stylex.props(styles.footer)}>
            <Dialog.Root>
              <Dialog.Trigger render={<Button />}>Settings</Dialog.Trigger>
              <Dialog.Content aria-label="Nested settings">
                <Button>Settings action</Button>
              </Dialog.Content>
            </Dialog.Root>
          </div>
        </FocusScope>
      </CompactNavigationDialog>
      <FocusScope
        id={WORKSPACE_FOCUS_SCOPES.content}
        inert={open}
        onFocusCapture={(event) => {
          returnFocus.current = event.target;
        }}
        {...stylex.props(styles.content)}
      >
        {!removeOpener && <Button onClick={() => setOpen(true)}>Show navigation sidebar</Button>}
        <Button onClick={() => setMachineOpen(true)}>Machine</Button>
        <Dialog.Root open={machineOpen} onOpenChange={setMachineOpen}>
          <Dialog.Content aria-label="Background machine picker">
            <Button>Demo machine</Button>
          </Dialog.Content>
        </Dialog.Root>
      </FocusScope>
    </div>
  );
}

const meta = {
  title: 'Layout/CompactNavigationDialog',
  parameters: { layout: 'fullscreen' },
  render: (args: { closeOnMount?: boolean }) => <Harness {...args} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The background stays usable: the closing dialog must finish and release it. */
export const ClosedBeforeFirstPaint: Story = { args: { closeOnMount: true } };
