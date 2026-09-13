import { Ledger } from '../src/ledger';
import { openRecoveryBackup } from '../src/recovery-file';

Object.assign(globalThis, { Ledger, openRecoveryBackup });
