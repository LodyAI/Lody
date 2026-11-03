import { atomWithStorage } from 'jotai/utils';

/**
 * Project hub prototype: project id → the Session that is its coordinator
 * ("main conversation"). Remembered on this device only until the
 * coordinator becomes a durable Project field.
 */
export const projectHubCoordinatorsAtom = atomWithStorage<Record<string, string>>(
  'lody-project-hub-coordinators',
  {}
);
