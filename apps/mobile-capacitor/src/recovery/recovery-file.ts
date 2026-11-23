import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/** iOS clears after sharing; Android keeps the file for the receiving app until next export.
 * The caller still verifies the saved file: a closed sheet is no proof of a save. */
export async function exportMobileRecoveryFile(
  file: Uint8Array,
  check: () => void
): Promise<boolean> {
  check();
  if (file.length < 1 || file.length > 4096) throw new Error('e2ee_recovery_invalid-input');
  const android = Capacitor.getPlatform() === 'android';
  const path = `lody-recovery-${crypto.randomUUID()}.lodyrecovery`;
  try {
    if (android) {
      const previous = await Filesystem.readdir({ path: '', directory: Directory.Cache });
      for (const file of previous.files) {
        if (file.type === 'file' && /^lody-recovery-[0-9a-f-]{36}\.lodyrecovery$/.test(file.name))
          await Filesystem.deleteFile({ path: file.name, directory: Directory.Cache });
      }
      check();
    }
    const written = await Filesystem.writeFile({
      path,
      directory: Directory.Cache,
      data: btoa(String.fromCharCode(...file)),
    });
    check();
    try {
      await Share.share({ files: [written.uri] });
    } catch (error) {
      if (error instanceof Error && error.message === 'Share canceled') return false;
      throw new Error('e2ee_recovery_storage');
    }
    check();
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'e2ee_recovery_cancelled') throw error;
    throw new Error('e2ee_recovery_storage');
  } finally {
    // Android's target can still be reading after the chooser settles; clean it on next export.
    if (!android) {
      await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {
        throw new Error('e2ee_recovery_storage');
      });
    }
  }
}
