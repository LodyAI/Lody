import { SqliteTextStore, type TextTransaction } from './node-text-store';
import { createUserIdentity, restoreUserIdentity, type UserIdentity } from './user-identity';
import {
  openRecoveryBackup,
  sealRecoveryBackup,
  type RecoveryBackupContext,
} from './recovery-file';
import { checkHex, ControlLogError, fromHex, invariant, toHex } from './wire';

export interface LocalUserProtection {
  seal(accountBinding: string, material: Uint8Array): Uint8Array;
  open(accountBinding: string, wrapped: Uint8Array): Uint8Array;
}
const FORMAT = 'lody-user-identity-store/v1';

/** Main/Node only. Separate from device storage; never implicitly replaces an identity.
 * The trusted caller owns account binding/session checks and independent identity trust.
 * Storage/restoration alone never grants Org membership or restores a device identity.
 */
export class SqliteUserIdentityStore {
  private readonly database: SqliteTextStore;
  constructor(
    path: string,
    private readonly binding: string,
    private readonly protection: LocalUserProtection
  ) {
    checkHex(binding, 32);
    this.database = new SqliteTextStore(path, 0x4c554931, 1);
  }

  private async saveNew(
    tx: TextTransaction,
    material: Uint8Array,
    fingerprint: string
  ): Promise<UserIdentity> {
    invariant((await tx.load()) === null, 'user-identity-exists');
    await restoreUserIdentity(material, fingerprint);
    const wrapped = this.protection.seal(this.binding, material);
    invariant(
      wrapped instanceof Uint8Array && wrapped.length > 0 && wrapped.length <= 8192,
      'invalid-wrapped-user'
    );
    const encoded = toHex(wrapped);
    const opened = this.protection.open(this.binding, fromHex(encoded));
    try {
      invariant(toHex(opened) === toHex(material), 'user-protection-roundtrip-mismatch');
      const identity = await restoreUserIdentity(opened, fingerprint);
      await tx.save(JSON.stringify([FORMAT, this.binding, fingerprint, encoded]));
      return identity;
    } finally {
      opened.fill(0);
    }
  }

  async create(): Promise<UserIdentity> {
    return this.database.exclusive(async (tx) => {
      invariant((await tx.load()) === null, 'user-identity-exists');
      const created = await createUserIdentity();
      try {
        return await this.saveNew(tx, created.privateMaterial, created.identity.fingerprint);
      } finally {
        created.privateMaterial.fill(0);
      }
    });
  }

  private async read(tx: TextTransaction): Promise<{ fingerprint: string; material: Uint8Array }> {
    const text = await tx.load();
    invariant(text !== null, 'user-identity-missing');
    invariant(text.length <= 17000, 'invalid-user-store');
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ControlLogError('invalid-user-store');
    }
    invariant(
      Array.isArray(value) &&
        value.length === 4 &&
        value[0] === FORMAT &&
        value[1] === this.binding &&
        JSON.stringify(value) === text,
      'user-store-binding-mismatch'
    );
    checkHex(value[2], 32);
    checkHex(value[3]);
    invariant(value[3].length > 0 && value[3].length <= 16384, 'invalid-wrapped-user');
    return {
      fingerprint: value[2],
      material: this.protection.open(this.binding, fromHex(value[3])),
    };
  }

  async load(): Promise<UserIdentity> {
    return this.database.exclusive(async (tx) => {
      const { fingerprint, material } = await this.read(tx);
      try {
        return await restoreUserIdentity(material, fingerprint);
      } finally {
        material.fill(0);
      }
    });
  }

  /** Encrypts locally; caller must upload/re-fetch/reselect before reporting backup ready. */
  async sealBackup(file: Uint8Array, context: RecoveryBackupContext): Promise<Uint8Array> {
    invariant(
      file instanceof Uint8Array && file.length > 0 && file.length <= 256,
      'invalid-recovery-file'
    );
    const copiedFile = new Uint8Array(file);
    const expected = { ...context };
    try {
      return await this.database.exclusive(async (tx) => {
        const { fingerprint, material } = await this.read(tx);
        try {
          invariant(fingerprint === expected.identity, 'user-identity-mismatch');
          await restoreUserIdentity(material, fingerprint);
          return sealRecoveryBackup(copiedFile, expected, material);
        } finally {
          material.fill(0);
        }
      });
    } finally {
      copiedFile.fill(0);
    }
  }

  /** Explicit recovery into an empty user store only. It neither replaces an existing
   * local identity nor authorizes a new device in an Org. */
  async recover(
    file: Uint8Array,
    context: RecoveryBackupContext,
    frame: Uint8Array
  ): Promise<UserIdentity> {
    const material = openRecoveryBackup(file, context, frame);
    const expected = context.identity;
    try {
      return await this.database.exclusive((tx) => this.saveNew(tx, material, expected));
    } finally {
      material.fill(0);
    }
  }
}
