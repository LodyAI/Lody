import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Dialog } from '@lody/ui/dialog';
import { AlertDialog } from '@lody/ui/alert-dialog';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { ThemeRoot } from '@lody/ui/theme';
import { ModalContainerProvider } from '@lody/ui/popup-container';

const styles = stylex.create({
  frame: { padding: 24, minHeight: 560 },
  body: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  host: { position: 'relative', minHeight: 720 },
});
type Layout = 'default' | 'padding' | 'gap' | 'both';
type Kind = 'dialog' | 'alert';

function layoutProps(layout: Layout) {
  return {
    padding: layout === 'padding' || layout === 'both' ? ('none' as const) : undefined,
    gap: layout === 'gap' || layout === 'both' ? ('none' as const) : undefined,
  };
}

function Fixture({
  kind = 'dialog',
  initial = 'default',
  update = false,
  callerStyle = false,
}: {
  kind?: Kind;
  initial?: Layout;
  update?: boolean;
  callerStyle?: boolean;
}) {
  const [layout, setLayout] = useState(initial);
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState('Preserved modal value');
  const [changes, setChanges] = useState(0);
  const Modal = kind === 'alert' ? AlertDialog : Dialog;
  return (
    <div
      data-modal-spacing={kind}
      data-layout={layout}
      data-open={open}
      data-value={value}
      data-open-changes={changes}
      data-caller-style={callerStyle}
      {...stylex.props(styles.frame)}
    >
      <Modal.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setChanges((count) => count + 1);
        }}
      >
        <Modal.Trigger render={<Button />}>Open spacing panel</Modal.Trigger>
        <Modal.Content
          {...layoutProps(layout)}
          data-modal-spacing-panel={kind}
          width="360px"
          style={
            callerStyle ? () => ({ padding: 23, gap: 9, overscrollBehavior: 'contain' }) : undefined
          }
        >
          <Modal.Header>
            <Modal.Title>Modal spacing contract</Modal.Title>
            <Modal.Description>Spacing belongs to this actual panel.</Modal.Description>
          </Modal.Header>
          <div {...stylex.props(styles.body)}>
            <label htmlFor="modal-spacing-value">Retained value</label>
            <Input
              id="modal-spacing-value"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            {update ? (
              <div {...stylex.props(styles.row)}>
                <Button onClick={() => setLayout('padding')}>Zero padding</Button>
                <Button onClick={() => setLayout('gap')}>Zero gap</Button>
                <Button onClick={() => setLayout('both')}>Zero both</Button>
                <Button onClick={() => setLayout('default')}>Restore omitted spacing</Button>
              </div>
            ) : null}
            <output data-modal-spacing-value>{value}</output>
          </div>
          <Modal.Footer>
            <Modal.Close render={<Button variant="secondary" />}>Close spacing panel</Modal.Close>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </div>
  );
}

function HostedFixture() {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <ThemeRoot mode="dark">
      <div ref={setHost} data-modal-spacing-host {...stylex.props(styles.host)}>
        <ModalContainerProvider container={host}>
          {host ? <Fixture kind="alert" initial="both" /> : null}
        </ModalContainerProvider>
      </div>
    </ThemeRoot>
  );
}

const meta = {
  title: 'Migration/OwnedModalSpacing',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DialogDefault: Story = {};
export const DialogNoPadding: Story = { args: { initial: 'padding' } };
export const DialogNoGap: Story = { args: { initial: 'gap' } };
export const DialogNoBoth: Story = { args: { initial: 'both' } };
export const AlertDefault: Story = { args: { kind: 'alert' } };
export const AlertNoPadding: Story = { args: { kind: 'alert', initial: 'padding' } };
export const AlertNoGap: Story = { args: { kind: 'alert', initial: 'gap' } };
export const AlertNoBoth: Story = { args: { kind: 'alert', initial: 'both' } };
export const DialogUpdate: Story = { args: { initial: 'both', update: true } };
export const AlertUpdate: Story = { args: { kind: 'alert', initial: 'both', update: true } };
export const CallerInline: Story = { args: { initial: 'both', callerStyle: true } };
export const HostedDarkAlert: Story = { render: () => <HostedFixture /> };
