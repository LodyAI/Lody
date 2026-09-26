import { useState, type CSSProperties, type ReactNode } from 'react';
import { BOOT_SHELL_CSS, BOOT_SHELL_MARK_SIZE } from '@/lib/boot-shell';
import { BOOT_SHELL_MARK_DATA_URL } from '@/lib/boot-shell-mark';

/**
 * React's copy of the boot shell (`lib/boot-shell.ts`) for the gates that run
 * before the workspace layout exists. It renders the same markup and classes
 * as the frame inlined into `index.html`, so replacing that frame on the first
 * commit changes nothing on screen; only the real layout replacing this does.
 *
 * Whether the sidebar column shows was decided once by the boot script
 * (`data-lody-boot-sidebar` on `<html>`); `sidebar` overrides it where no boot
 * script ran, such as Storybook.
 */
export function BootShell({ status, sidebar }: { status?: ReactNode; sidebar?: boolean }) {
  // Creation time, so the mark's animation keeps the static frame's phase.
  const [elapsedMs] = useState(() =>
    typeof performance === 'undefined' ? 0 : Math.round(performance.now())
  );

  return (
    <>
      {/* Already inlined in `index.html`; hoisted and deduplicated by React for
          hosts that load the bundle without the boot shell plugin. */}
      <style href="lody-boot-shell" precedence="lody-boot-shell">
        {BOOT_SHELL_CSS}
      </style>
      <div
        className="lody-boot-shell"
        data-lody-boot-shell=""
        data-sidebar={sidebar === undefined ? undefined : sidebar ? 'shown' : 'hidden'}
        aria-busy="true"
        style={{ '--lody-boot-elapsed': `${elapsedMs}ms` } as CSSProperties}
      >
        <div className="lody-boot-shell__sidebar" />
        <div className="lody-boot-shell__main">
          <img
            className="lody-boot-shell__mark"
            src={BOOT_SHELL_MARK_DATA_URL}
            alt=""
            width={BOOT_SHELL_MARK_SIZE}
            height={BOOT_SHELL_MARK_SIZE}
            decoding="sync"
          />
          {status ? (
            <div className="lody-boot-shell__status" role="status" aria-live="polite">
              {status}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
