// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  harness,
  effectiveConfig,
  overriddenKeys,
  getHarness,
} from '../src/components/harness/store';
import { MODELS, PLUGIN_PRESETS } from '../src/components/harness/catalog';

/**
 * The harness config model: one shared profile, per-device overrides that fall
 * away when they match the profile, and model picks that stay valid after a
 * provider is disconnected. A device that keeps a stale override, or a model id
 * whose provider is gone, is what these cases exist to catch.
 */
beforeEach(() => {
  window.localStorage.clear();
  harness.reset();
});

describe('harness store', () => {
  it('pairs a device, selects it and writes the profile', () => {
    const id = harness.pair('local');

    expect(getHarness().devices).toHaveLength(1);
    expect(getHarness().activeDevice).toBe(id);
    expect(effectiveConfig(getHarness(), id).plugins).toEqual(PLUGIN_PRESETS.recommended);
  });

  it('keeps a device override only while it differs from the profile', () => {
    const id = harness.pair('local');
    harness.set({ device: id }, 'autonomy', 'auto');
    expect(overriddenKeys(getHarness(), id)).toEqual(['autonomy']);

    // Writing the profile's own value back is not an override.
    harness.set({ device: id }, 'autonomy', getHarness().profile.autonomy);
    expect(overriddenKeys(getHarness(), id)).toEqual([]);
    expect(effectiveConfig(getHarness(), id).autonomy).toBe(getHarness().profile.autonomy);
  });

  it('applies a profile edit to a device that overrides something else', () => {
    const id = harness.pair('local');
    harness.set({ device: id }, 'autonomy', 'auto');
    harness.set('profile', 'network', 'on');

    const config = effectiveConfig(getHarness(), id);
    expect(config.network).toBe('on');
    expect(config.autonomy).toBe('auto');

    harness.resetOverride(id, ['autonomy']);
    expect(effectiveConfig(getHarness(), id).autonomy).toBe(getHarness().profile.autonomy);
  });

  it('replaces a model whose provider was disconnected', () => {
    harness.connect('anthropic', 'key', 'sk-ant-test');
    const anthropicModel = MODELS.find((model) => model.provider === 'anthropic')!;
    harness.set('profile', 'mainModel', anthropicModel.id);

    harness.disconnect('anthropic');

    const config = getHarness().profile;
    expect(['', ...MODELS.filter((m) => m.provider !== 'anthropic').map((m) => m.id)]).toContain(
      config.mainModel
    );
  });

  it('drops the overrides of an unpaired device and selects another', () => {
    const first = harness.pair('local');
    const second = harness.pair('remote');
    harness.set({ device: second }, 'autonomy', 'auto');

    harness.unpair(second);

    expect(getHarness().devices.map((device) => device.id)).toEqual([first]);
    expect(getHarness().activeDevice).toBe(first);
    expect(getHarness().overrides).not.toHaveProperty(second);
  });

  it('persists the paired device so a reload keeps the harness', async () => {
    const id = harness.pair('local');
    await Promise.resolve();

    const stored = JSON.parse(window.localStorage.getItem('lody-harness-v1') ?? '{}');
    expect(stored.devices.map((device: { id: string }) => device.id)).toEqual([id]);
  });
});
