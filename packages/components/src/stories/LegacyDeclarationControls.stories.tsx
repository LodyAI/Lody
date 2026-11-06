import type { Meta, StoryObj } from '@storybook/react';
import { Slot } from '@radix-ui/react-slot';
import * as stylex from '@stylexjs/stylex';
import { Spinner } from '@lody/ui/spinner';
import { MobileInlinePicker } from '@/components/mobile/mobile-inline-picker';
import { AdaptiveTabStrip, AdaptiveTabStripItem } from '@/components/sessions/adaptive-tab-strip';

const ordinary = stylex.create({
  opacity: { opacity: 0.4 },
  width: { width: '420px' },
  half: { opacity: 0.5 },
  muted: { opacity: 0.7 },
  faint: { opacity: 0.2 },
  directSpinner: { ':is(*) [data-slot=spinner]': { opacity: 1 } },
  faintSpinner: { ':is(*) [data-slot=spinner]': { opacity: 0.2 } },
  zeroWidth: { width: 0 },
  minWidth: { minWidth: 840 },
  overflow: { overflow: 'visible' },
});
const meta = {
  title: 'UI/LegacyDeclarationControls',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Opacity: Story = {
  render: () => (
    <main style={{ padding: 16 }}>
      <h1>Actual picker and public class controls</h1>
      {[
        ['default', ''],
        ['zero-ancestor', ''],
        ['direct-ancestor', stylex.props(ordinary.directSpinner).className],
        ['arbitrary-ancestor', stylex.props(ordinary.faintSpinner).className],
      ].map(([id, cls]) => (
        <section key={id} data-case={id}>
          <p>{id}</p>
          <MobileInlinePicker
            id={'compat-' + id}
            value="main"
            options={[{ value: 'main', label: 'main' }]}
            onChange={() => {}}
            loading
            loadingText="Loading branches"
            triggerContent={<span>main</span>}
            triggerClassName={cls}
            ariaLabel={id ?? 'Picker'}
          />
        </section>
      ))}
      <section data-case="named-caller">
        <p>Named cn caller</p>
        <Spinner className={stylex.props(ordinary.half).className} />
      </section>
      <section data-case="opaque-stylex">
        <p>Ordinary opaque atom</p>
        <Spinner className={stylex.props(ordinary.opacity).className} />
      </section>
      <section data-case="arbitrary-caller">
        <p>Arbitrary property</p>
        <Spinner className={stylex.props(ordinary.faint).className} />
      </section>
      <section data-case="slot">
        <p>Real Radix Slot composition</p>
        <Slot className={stylex.props(ordinary.half).className}>
          <Spinner className={stylex.props(ordinary.muted).className} />
        </Slot>
      </section>
      <section data-case="ordinary-stylex">
        <p>Ordinary atom without legacy default</p>
        <Spinner className={stylex.props(ordinary.opacity).className} />
      </section>
    </main>
  ),
};

const cases = [
  { id: 'default' },
  { id: 'arbitrary-width', strip: ordinary.zeroWidth },
  { id: 'named-width', strip: ordinary.zeroWidth },
  { id: 'arbitrary-min', viewport: ordinary.minWidth },
  { id: 'named-min', viewport: ordinary.minWidth },
  { id: 'arbitrary-overflow', item: ordinary.overflow },
  { id: 'named-overflow', item: ordinary.overflow },
  { id: 'opaque-width', strip: ordinary.width },
];
export const Adaptive: Story = {
  render: () => (
    <main style={{ width: 1100, padding: 24, fontFamily: 'Arial' }}>
      <h1>Actual Adaptive defaults and public caller precedence</h1>
      {cases.map((c) => (
        <section key={c.id} data-case={c.id} style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>{c.id}</h2>
          <div
            data-host
            style={{
              display: 'flex',
              width: 600,
              height: 44,
              background: '#dce5f1',
              border: '1px solid #345',
            }}
          >
            <AdaptiveTabStrip
              itemIds={['a', 'b']}
              activeItemId={null}
              xstyle={c.strip}
              viewportXstyle={c.viewport}
            >
              <AdaptiveTabStripItem
                itemId="a"
                xstyle={c.item}
                style={{ height: 40, background: '#92b4de' }}
              >
                <button
                  type="button"
                  style={{
                    display: 'block',
                    width: 900,
                    whiteSpace: 'nowrap',
                    height: 35,
                    background: '#eec993',
                  }}
                  data-hit
                >
                  Actual Adaptive child with overflowing content and native pointer target
                </button>
              </AdaptiveTabStripItem>
              <AdaptiveTabStripItem itemId="b" style={{ height: 40, background: '#abc' }}>
                <span>Second item</span>
              </AdaptiveTabStripItem>
            </AdaptiveTabStrip>
          </div>
        </section>
      ))}
    </main>
  ),
};
