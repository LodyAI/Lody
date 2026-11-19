import type { LodyWorld } from './world.js';

/**
 * A desktop composition a journey can run on. Only the preparation that differs
 * between compositions lives here; product steps and Page Objects are shared.
 */
export type DesktopTarget = {
  /** Brings the launched desktop to an editable workspace composer. */
  enterUsableWorkspace(world: LodyWorld): Promise<void>;
};

const targets = new Map<string, DesktopTarget>();

/** An embedding repository registers its own target from a support file it imports. */
export function registerDesktopTarget(name: string, target: DesktopTarget): void {
  if (targets.has(name)) throw new Error(`Desktop target ${name} is already registered`);
  targets.set(name, target);
}

/** `LODY_E2E_TARGET` selects the target; the OSS build is `oss-local`. */
export function activeDesktopTarget(): DesktopTarget {
  const name = process.env.LODY_E2E_TARGET?.trim() || 'oss-local';
  const target = targets.get(name);
  if (!target) throw new Error(`Desktop target ${name} is not registered`);
  return target;
}

registerDesktopTarget('oss-local', {
  async enterUsableWorkspace(world) {
    if (!world.onboarding) throw new Error('Scenario is not ready to enter a workspace');
    await world.onboarding.waitForLocalBootstrap();
    await world.onboarding.skipConfigurationAndEnterProduct();
  },
});
