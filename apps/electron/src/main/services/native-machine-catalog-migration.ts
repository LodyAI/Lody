import {
  NativeFlockRoomGroupMigrationLegacy,
  type NativeFlockRoomGroupMigrationOptions
} from './native-flock-room-group-migration'
import type { ProcessFacadeOptions } from '@lody/shared/node/process'
export type NativeMachineCatalogMigrationOptions = Omit<
  NativeFlockRoomGroupMigrationOptions,
  'domain'
>
export { NativeFlockRoomGroupMigrationFailure as NativeMachineCatalogMigrationFailure } from './native-flock-room-group-migration'
/** Machine-specific trusted composition of the shared room-group workflow. */
export class NativeMachineCatalogMigrationLegacy extends NativeFlockRoomGroupMigrationLegacy {
  constructor(options: NativeMachineCatalogMigrationOptions, process: ProcessFacadeOptions = {}) {
    super({ ...options, domain: 'machine' }, process)
  }
}
