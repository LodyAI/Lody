import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Provider } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import type { TokensFromVarGroup } from '@stylexjs/stylex/lib/types/StyleXTypes';
import type { SessionId } from '@lody/shared';
import { button } from '@lody/ui/button/button.tokens.stylex';
import { ModalContainerProvider } from '@lody/ui/popup-container';
import {
  MobileAppIconSettings,
  type AppIconBridge,
} from '../components/mobile/mobile-app-icon-settings';
import { OperationReplyCard } from '../components/ai-gui/operation-reply-card';
import { SettingsStoryProviders } from './settings-story-shell';

// The locked compiler drops imported object spreads. Keep the full map local
// so the fixture inherits every token it does not deliberately override.
const inheritedButtonTokens = {
  heightMini: 'inherit',
  heightSmall: 'inherit',
  heightMedium: 'inherit',
  heightLarge: 'inherit',
  paddingXMini: 'inherit',
  paddingXSmall: 'inherit',
  paddingXMedium: 'inherit',
  paddingXLarge: 'inherit',
  radiusMini: 'inherit',
  radiusSmall: 'inherit',
  radiusMedium: 'inherit',
  textMini: 'inherit',
  text: 'inherit',
  gap: 'inherit',
  iconSize: 'inherit',
  primaryBackground: 'inherit',
  primaryLabel: 'inherit',
  primaryEdge: 'inherit',
  primarySheen: 'inherit',
  secondaryBackground: 'inherit',
  secondaryShadow: 'inherit',
  secondarySheen: 'inherit',
  pressedEdge: 'inherit',
  ghostLabel: 'inherit',
  ghostHover: 'inherit',
  ring: 'inherit',
  ringWidth: 'inherit',
} satisfies Record<keyof TokensFromVarGroup<typeof button>, 'inherit'>;

const parentTheme = stylex.createTheme(button, {
  ...inheritedButtonTokens,
  heightMedium: '38px',
  heightSmall: '30px',
  radiusMedium: '11px',
  radiusSmall: '9px',
  iconSize: '18px',
  gap: '13px',
  paddingXMedium: '17px',
  paddingXSmall: '19px',
  ring: 'rgb(169, 31, 171)',
});
const preview = (fill: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="${fill}"/></svg>`)}`;

function Icons({ mode = 'ready' }: { mode?: 'ready' | 'pending' | 'error' }) {
  const [receipt, setReceipt] = useState('none');
  const bridge = useMemo<AppIconBridge>(
    () => ({
      icons: [
        { name: 'default', previewUrl: preview('#333333') },
        { name: 'alternate', displayName: 'Synthetic alternate', previewUrl: preview('#269dcc') },
      ],
      getState: async () => ({ supported: true, name: 'default' }),
      setIcon: async ({ name }) => {
        setReceipt(`${mode}:${name}`);
        if (mode === 'pending') return new Promise(() => {});
        if (mode === 'error') throw new globalThis.Error('Synthetic native icon rejection');
        return { supported: true, name };
      },
    }),
    [mode]
  );
  return (
    <>
      <section data-private-layout="icons-mobile">
        <MobileAppIconSettings bridge={bridge} />
      </section>
      <section data-private-layout="icons-desktop">
        <MobileAppIconSettings bridge={bridge} layout="desktop" />
      </section>
      <output data-icon-receipt>{receipt}</output>
    </>
  );
}
function Operation() {
  const [receipt, setReceipt] = useState('none');
  return (
    <section data-private-layout="operation">
      <OperationReplyCard
        sessionId={'private-layout-operation' as SessionId}
        fallbackTitle="Synthetic operation reply title 中文"
        status="succeeded"
        reply="Synthetic full reply body for the real dialog."
        onNavigateSession={(target) => setReceipt(target.sessionId)}
      />
      <output data-operation-receipt>{receipt}</output>
    </section>
  );
}
function Fixture({
  kind = 'icons',
  scoped = false,
  mode = 'ready',
  inline = false,
}: {
  kind?: 'icons' | 'operation';
  scoped?: boolean;
  mode?: 'ready' | 'pending' | 'error';
  inline?: boolean;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!inline || !ref.current) return;
    for (const target of ref.current.querySelectorAll<HTMLButtonElement>('button')) {
      target.style.setProperty(button.gap.slice(4, -1), '23px');
      target.style.setProperty(button.paddingXMedium.slice(4, -1), '27px');
      target.style.setProperty(button.paddingXSmall.slice(4, -1), '29px');
    }
  }, [inline, host]);
  return (
    <Provider>
      <SettingsStoryProviders>
        <div
          ref={ref}
          data-private-layout-fixture={kind}
          data-private-layout-scoped={scoped}
          {...stylex.props(scoped && parentTheme)}
          style={
            {
              padding: 20,
              minHeight: '100vh',
              ...(scoped ? { '--spacing': '5px' } : {}),
            } as CSSProperties
          }
        >
          <div ref={setHost} data-private-layout-portal />
          <ModalContainerProvider container={host}>
            {host ? kind === 'icons' ? <Icons mode={mode} /> : <Operation /> : null}
          </ModalContainerProvider>
        </div>
      </SettingsStoryProviders>
    </Provider>
  );
}
const meta = {
  title: 'Migration/OwnedPrivateButtonLayout',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const IconsReady: Story = {};
export const IconsScopedPending: Story = { args: { scoped: true, mode: 'pending' } };
export const IconsFailure: Story = { args: { mode: 'error' } };
export const OperationDefault: Story = { args: { kind: 'operation' } };
export const OperationScoped: Story = { args: { kind: 'operation', scoped: true } };
export const InlineTargets: Story = { args: { inline: true, scoped: true } };
