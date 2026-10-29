import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { type AvatarSize } from '@lody/ui/avatar';
import { avatar } from '@lody/ui/avatar/avatar.tokens.stylex';
import { Button } from '@lody/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { WorkspaceAvatar } from '@/components/workspace-avatar';

const glyphTheme = stylex.createTheme(avatar, {
  sizeMini: 'inherit',
  sizeSmall: 'inherit',
  sizeMedium: 'inherit',
  sizeLarge: 'inherit',
  sizeXlarge: 'inherit',
  initialsMini: 'inherit',
  initialsSmall: 'inherit',
  initialsMedium: 'inherit',
  initialsLarge: 'inherit',
  initialsXlarge: 'inherit',
  glyphMini: '7px',
  glyphSmall: '9px',
  glyphMedium: '11px',
  glyphLarge: '13px',
  glyphXlarge: '19px',
  tileRadiusMini: 'inherit',
  tileRadiusSmall: 'inherit',
  tileRadiusMedium: 'inherit',
  tileRadiusLarge: 'inherit',
  tileRadiusXlarge: 'inherit',
  fallbackBackground: 'inherit',
  fallbackLabel: 'inherit',
});
const styles = stylex.create({
  frame: { padding: '12px' },
  row: { display: 'flex', gap: '6px', alignItems: 'end', marginBottom: '12px' },
  cell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    width: '64px',
    gap: '4px',
  },
  caption: { fontSize: '9px' },
  heading: { fontSize: '12px', marginBlock: '8px' },
});
const sizes = [
  'mini',
  'small',
  'medium',
  'large',
  'xlarge',
] as const satisfies readonly AvatarSize[];

function Fixture({ initialThemed = false }: { initialThemed?: boolean }) {
  const [themed, setThemed] = useState(initialThemed);
  return (
    <div
      data-avatar-glyph-theme={themed ? 'custom' : 'default'}
      {...stylex.props(styles.frame, themed && glyphTheme)}
    >
      <Button onClick={() => setThemed(!themed)}>Toggle glyph theme</Button>
      {sizes.map((size) => (
        <section key={size} data-avatar-size={size}>
          <h2 {...stylex.props(styles.heading)}>{size}</h2>
          <div {...stylex.props(styles.row)}>
            <div data-avatar-case="user-empty" {...stylex.props(styles.cell)}>
              <UserAvatar size={size} />
              <span {...stylex.props(styles.caption)}>User empty</span>
            </div>
            <div data-avatar-case="user-icon" {...stylex.props(styles.cell)}>
              <UserAvatar size={size} user={{ name: 'Synthetic Person' }} showIcon />
              <span {...stylex.props(styles.caption)}>User icon</span>
            </div>
            <div data-avatar-case="workspace-empty" {...stylex.props(styles.cell)}>
              <WorkspaceAvatar size={size} />
              <span {...stylex.props(styles.caption)}>Workspace empty</span>
            </div>
            <div data-avatar-case="user-initials" {...stylex.props(styles.cell)}>
              <UserAvatar size={size} user={{ name: 'Synthetic Person' }} />
              <span {...stylex.props(styles.caption)}>User initials</span>
            </div>
            <div data-avatar-case="workspace-initial" {...stylex.props(styles.cell)}>
              <WorkspaceAvatar size={size} workspace={{ name: 'Synthetic Workspace' }} />
              <span {...stylex.props(styles.caption)}>Workspace initial</span>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
const meta = {
  title: 'Components/OwnedAvatarGlyphMigration',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AllRungs: Story = {};
export const ParentGlyphTheme: Story = { args: { initialThemed: true } };
