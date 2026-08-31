import { useEffect, useState } from 'react';
import {
  PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT,
  PATH_LAUNCHER_PREFERENCE_STORAGE_KEY,
  readStoredPathLauncherPreference,
  type PathLauncherPreference,
} from '@/lib/session-path-launchers';

/**
 * The stored "Open in" launcher choice, kept live.
 *
 * Two channels, because the preference moves two ways: the in-page custom event
 * (`writeStoredPathLauncherPreference` dispatches it, so Settings and the header
 * split button agree without a reload) and the `storage` event (another window
 * of the same app changed it).
 *
 * Shared by every surface that offers a launcher — the session header's split
 * button and the Files tree's row menu — so a change in Settings reaches both.
 */
export function usePathLauncherPreference(): PathLauncherPreference {
  const [preference, setPreference] = useState(readStoredPathLauncherPreference);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const refreshPreference = () => {
      setPreference(readStoredPathLauncherPreference());
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === PATH_LAUNCHER_PREFERENCE_STORAGE_KEY) {
        refreshPreference();
      }
    };

    window.addEventListener(PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT, refreshPreference);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(PATH_LAUNCHER_PREFERENCE_CHANGED_EVENT, refreshPreference);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  return preference;
}
