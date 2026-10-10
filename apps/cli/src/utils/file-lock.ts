export type { LockOptions } from '@lody/shared/node/file-lock';
export {
  withFileLock,
  fileLocksLegacy,
  cleanupStaleLocks,
  FileLocks,
  fileLockLayer,
} from '@lody/shared/node/file-lock';
