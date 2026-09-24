import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import {
  AppearanceSettingsView,
  type AppearanceSettingsViewProps,
} from '@/components/settings/appearance-setting';
import { Dialog } from '@/ui/dialog';

const systemFontFamilies = [
  'Fira Code',
  'JetBrains Mono',
  'Maple Mono',
  'SF Mono',
  ...Array.from({ length: 72 }, (_, index) => `System Font ${String(index + 1).padStart(2, '0')}`),
];

function ControlledAppearanceSettings({ isElectron }: { isElectron: boolean }) {
  const [theme, setTheme] = useState<AppearanceSettingsViewProps['theme']>('light');
  const [conversationFontSize, setConversationFontSize] =
    useState<AppearanceSettingsViewProps['conversationFontSize']>(14);
  const [interfaceFontFamily, setInterfaceFontFamily] = useState('Inter');
  const [terminalFontFamily, setTerminalFontFamily] = useState('');
  const [terminalFontSize, setTerminalFontSize] = useState(13);
  const [fontLigaturesEnabled, setFontLigaturesEnabled] = useState(true);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <AppearanceSettingsView
        theme={theme}
        onThemePreview={setTheme}
        onThemeCommit={setTheme}
        onThemeCancel={() => undefined}
        conversationFontSize={conversationFontSize}
        onConversationFontSizeChange={setConversationFontSize}
        isElectron={isElectron}
        interfaceFontFamily={interfaceFontFamily}
        onInterfaceFontFamilyChange={setInterfaceFontFamily}
        terminalFontFamily={terminalFontFamily}
        onTerminalFontFamilyChange={setTerminalFontFamily}
        systemFontFamilies={systemFontFamilies}
        systemFontLoadState="loaded"
        onSystemFontMenuOpen={() => undefined}
        terminalFontSize={terminalFontSize}
        onTerminalFontSizeChange={setTerminalFontSize}
        fontLigaturesEnabled={fontLigaturesEnabled}
        onFontLigaturesEnabledChange={setFontLigaturesEnabled}
      />
    </div>
  );
}

const meta = {
  title: 'Settings/AppearanceSettings',
  component: ControlledAppearanceSettings,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof ControlledAppearanceSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Electron: Story = {
  args: {
    isElectron: true,
  },
};

export const ElectronInDialog: Story = {
  args: {
    isElectron: true,
  },
  render: (args) => (
    <Dialog.Root open>
      <Dialog.Content>
        <Dialog.Title>Appearance</Dialog.Title>
        <Dialog.Description>Electron appearance settings</Dialog.Description>
        <ControlledAppearanceSettings {...args} />
      </Dialog.Content>
    </Dialog.Root>
  ),
};

export const Web: Story = {
  args: {
    isElectron: false,
  },
};
