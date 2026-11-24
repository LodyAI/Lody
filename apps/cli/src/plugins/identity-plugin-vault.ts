import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { stat, rm, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { systemMachineConfigVault, type MachineConfigVault } from './plugin-machine-config';

const wrappingKey = (root: string) => JSON.stringify(['encrypted-plugin-config', root]);

/** Delete the exact credential before its on-disk ownership marker; a locked vault is retryable. */
export async function eraseIdentityPluginCustody(
  root: string,
  os: Pick<typeof systemMachineConfigVault, 'remove'> = systemMachineConfigVault
) {
  const used = await stat(join(root, 'settings')).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
  if (used) await os.remove(wrappingKey(root));
  await rm(root, { recursive: true, force: true });
}
/** Only the wrapping key lives in the OS vault; revoking this identity erases its ciphertext. */
export function identityPluginVault(
  root: string,
  os: MachineConfigVault = systemMachineConfigVault
): MachineConfigVault {
  const directory = join(root, 'settings');
  const namespace = wrappingKey(root);
  const file = (key: string) => join(directory, createHash('sha256').update(key).digest('hex'));
  let opening: Promise<Buffer> | undefined;
  async function open(create: boolean) {
    const retained = await os.read(namespace);
    if (retained) return Buffer.from(retained, 'base64');
    if (!create) throw Error('Plugin configuration wrapping key unavailable');
    const bytes = randomBytes(32);
    await os.write(namespace, bytes.toString('base64'));
    return bytes;
  }
  const wrapping = (create: boolean) =>
    (opening ??= open(create).catch((error) => {
      opening = undefined;
      throw error;
    }));
  return {
    async read(key) {
      const data = await readFile(file(key)).catch((err) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      });
      if (!data) return undefined;
      const cipher = createDecipheriv('aes-256-gcm', await wrapping(false), data.subarray(0, 12));
      cipher.setAAD(Buffer.from(key));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString();
    },
    async write(key, value) {
      // Persist ownership before creating the key, including on an interrupted first write.
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', await wrapping(true), nonce);
      cipher.setAAD(Buffer.from(key));
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const tmp = join(directory, randomUUID());
      await writeFile(tmp, Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]), {
        mode: 0o600,
      });
      await rename(tmp, file(key));
    },
  };
}
