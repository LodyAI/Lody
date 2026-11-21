import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/** Own the temporary until the native share sheet has actually settled. The caller
 * still asks the person to select the exported file: a closed sheet is no proof of a save. */
export async function exportMobileRecoveryFile(
  file: Uint8Array,
  check: () => void
): Promise<boolean> {
  check();
  if (file.length < 1 || file.length > 4096) throw new Error('e2ee_recovery_invalid-input');
  const path = `lody-recovery-${crypto.randomUUID()}.lodyrecovery`;
  try {
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
    // Failure to remove a secret temporary is not a successful export.
    await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {
      throw new Error('e2ee_recovery_storage');
    });
  }
}
