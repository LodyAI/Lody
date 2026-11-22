// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  harness,
  effectiveConfig,
  overriddenKeys,
  getHarness,
} from '../src/components/harness/store';
import { MODELS } from '../src/components/harness/catalog';

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
  it('selects a machine and remembers which profile values were set for all devices', () => {
    harness.select('machine-a');
    expect(getHarness().activeDevice).toBe('machine-a');
    expect(getHarness().profileKeys ?? []).toEqual([]);

    harness.setProfileDefault('autonomy', 'auto');
    harness.setProfileDefault('autonomy', 'ask');
    // Only keys set through the profile can mark a device as differing.
    expect(getHarness().profileKeys).toEqual(['autonomy']);
    expect(getHarness().profile.autonomy).toBe('ask');
  });

  it('keeps a device override only while it differs from the profile', () => {
    const id = 'machine-a';
    harness.select(id);
    harness.set({ device: id }, 'autonomy', 'auto');
    expect(overriddenKeys(getHarness(), id)).toEqual(['autonomy']);

    // Writing the profile's own value back is not an override.
    harness.set({ device: id }, 'autonomy', getHarness().profile.autonomy);
    expect(overriddenKeys(getHarness(), id)).toEqual([]);
    expect(effectiveConfig(getHarness(), id).autonomy).toBe(getHarness().profile.autonomy);
  });

  it('applies a profile edit to a device that overrides something else', () => {
    const id = 'machine-a';
    harness.select(id);
    harness.set({ device: id }, 'autonomy', 'auto');
    harness.set('profile', 'network', 'on');

    const config = effectiveConfig(getHarness(), id);
    expect(config.network).toBe('on');
    expect(config.autonomy).toBe('auto');

    harness.resetOverride(id, ['autonomy']);
    expect(effectiveConfig(getHarness(), id).autonomy).toBe(getHarness().profile.autonomy);
  });

  it('replaces a model whose provider leaves the machine read', () => {
    const anthropicModel = MODELS.find((model) => model.provider === 'anthropic')!;
    // What the machine reported last: anthropic had a key, now it is gone.
    harness.applyRemote({
      credentials: {
        anthropic: {
          provider: 'anthropic',
          method: 'key',
          account: 'API key',
          addedAt: Date.now(),
        },
      },
      customs: [],
      status: 'ready',
    });
    harness.set('profile', 'mainModel', anthropicModel.id);

    harness.applyRemote({ credentials: {}, customs: [], status: 'ready' });

    const config = getHarness().profile;
    // The machine no longer reports the provider, so the pick clears instead
    // of pointing at a model the agent cannot serve.
    expect(config.mainModel).toBe('');
  });

  it('drops the overrides of a departed machine and selects another', () => {
    harness.select('machine-a');
    harness.set({ device: 'machine-b' }, 'autonomy', 'auto');

    harness.forgetDevice('machine-b');

    expect(getHarness().activeDevice).toBe('machine-a');
    expect(getHarness().overrides).not.toHaveProperty('machine-b');
  });

  it('persists the selection so a reload keeps the harness', async () => {
    harness.select('machine-a');
    await Promise.resolve();

    const stored = JSON.parse(window.localStorage.getItem('lody-harness-v1') ?? '{}');
    expect(stored.activeDevice).toBe('machine-a');
    // Machine-owned lists are a live view, never persisted.
    expect(stored.devices).toBeUndefined();
  });
});
