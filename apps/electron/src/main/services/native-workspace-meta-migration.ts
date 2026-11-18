import {
  NativeFlockRoomGroupMigrationLegacy,
  type NativeFlockRoomGroupMigrationOptions
} from './native-flock-room-group-migration'
import type { ProcessFacadeOptions } from '@lody/shared/node/process'
/** Whole workspace Meta has an independent freeze witness and physical owner. */
export class NativeWorkspaceMetaMigrationLegacy extends NativeFlockRoomGroupMigrationLegacy {
  constructor(
    options: Omit<NativeFlockRoomGroupMigrationOptions, 'domain'>,
    process: ProcessFacadeOptions = {}
  ) {
    super({ ...options, domain: 'meta' }, process)
  }
}
