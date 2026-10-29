import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Menu } from '@/ui/menu';
import { EncryptedWorkspaceMark } from '@/components/e2ee/encrypted-workspace-mark';
import { MobileWorkspaceSwitcherSheet } from '@/components/mobile/mobile-workspace-switcher-sheet';

const styles = stylex.create({
  frame: { padding: '24px', color: 'rgb(98, 35, 120)' },
  row: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' },
  squeezed: { display: 'flex', width: '10px', marginInlineEnd: '12px' },
  caller: { display: 'inline-block', verticalAlign: '-2px' },
});

function Fixture({
  mode,
  scoped = false,
}: {
  mode: 'contracts' | 'menu' | 'sheet';
  scoped?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState('alpha');
  useLayoutEffect(() => {
    if (!scoped) return undefined;
    const target = document.body;
    const properties = { '--spacing': '5px', '--muted-foreground': '280 65% 42%' };
    const previous = Object.keys(properties).map((name) => [
      name,
      target.style.getPropertyValue(name),
    ]);
    for (const [name, value] of Object.entries(properties)) target.style.setProperty(name, value);
    return () => {
      for (const [name, value] of previous) {
        if (value) target.style.setProperty(name!, value);
        else target.style.removeProperty(name!);
      }
    };
  }, [scoped]);
  return (
    <div data-mark-mode={mode} data-mark-scoped={scoped} {...stylex.props(styles.frame)}>
      {mode === 'contracts' ? (
        <>
          <div data-mark-contract="omitted" {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.squeezed)}>
              <EncryptedWorkspaceMark />
            </span>
            Omitted className
          </div>
          <div data-mark-contract="undefined" {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.squeezed)}>
              <EncryptedWorkspaceMark className={undefined} />
            </span>
            Explicit undefined className
          </div>
          <div data-mark-contract="empty" {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.squeezed)}>
              <EncryptedWorkspaceMark className="" />
            </span>
            Empty className replaces defaults
          </div>
          <div data-mark-contract="opaque" {...stylex.props(styles.row)}>
            <span {...stylex.props(styles.squeezed)}>
              <EncryptedWorkspaceMark className={stylex.props(styles.caller).className} />
            </span>
            Opaque caller replaces defaults
          </div>
        </>
      ) : mode === 'menu' ? (
        <Menu.Root open={open} onOpenChange={setOpen}>
          <Menu.Trigger render={<Button>Choose workspace</Button>} />
          <Menu.Content>
            <Menu.RadioGroup value={selected} onValueChange={setSelected}>
              <Menu.RadioItem value="alpha" indicator="check" indicatorSide="end">
                Synthetic encrypted workspace <EncryptedWorkspaceMark />
              </Menu.RadioItem>
              <Menu.RadioItem value="empty" indicator="check" indicatorSide="end">
                Empty caller <EncryptedWorkspaceMark className="" />
              </Menu.RadioItem>
              <Menu.RadioItem value="opaque" indicator="check" indicatorSide="end">
                Opaque caller{' '}
                <EncryptedWorkspaceMark className={stylex.props(styles.caller).className} />
              </Menu.RadioItem>
            </Menu.RadioGroup>
          </Menu.Content>
        </Menu.Root>
      ) : (
        <MobileWorkspaceSwitcherSheet
          open={open}
          onOpenChange={setOpen}
          workspaces={[
            { id: 'alpha', name: 'Synthetic encrypted workspace', encrypted: true, isActive: true },
            {
              id: 'long',
              name: 'A deliberately long encrypted collaborative workspace name',
              encrypted: true,
            },
            { id: 'plain', name: 'Synthetic plain workspace' },
          ]}
          onSelect={setSelected}
          labels={{ title: 'Choose workspace', workspacesHeading: 'Workspaces' }}
        />
      )}
      <output data-mark-selected="">Selected: {selected}</output>
    </div>
  );
}

const meta = {
  title: 'Components/OwnedEncryptedWorkspaceMarkMigration',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Contracts: Story = { args: { mode: 'contracts' } };
export const ScopedContracts: Story = { args: { mode: 'contracts', scoped: true } };
export const MenuRows: Story = { args: { mode: 'menu' } };
export const ScopedMenuRows: Story = { args: { mode: 'menu', scoped: true } };
export const MobileSheet: Story = { args: { mode: 'sheet' } };
export const ScopedMobileSheet: Story = { args: { mode: 'sheet', scoped: true } };
