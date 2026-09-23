import { useRef } from 'react';
import { useAtomValue } from 'jotai';
import { useParams, useRouter, useSearch } from '@tanstack/react-router';
import type { SessionId } from '@lody/shared';
import { ChatLanding } from '@/components/chat/chat-landing';
import SessionDetail from '@/components/sessions/session-detail';
import { AppThemeShell } from '@/components/app-theme-shell';
import { Drawer, DrawerContent, DrawerTitle } from '@/ui/drawer';
import { VaulDrawerBody } from '@/components/mobile/vaul-drawer-edge-back-zone';
import { mobileWorkspaceBaseContextAtom, type MobileWorkspaceBaseContext } from '@/atoms';
import { isNativeAppShell } from '@/lib/native-platform';
import { useTranslation } from 'react-i18next';

const CHAT_ROUTE_ID = '/$workspaceName/_auth/chat';
const SESSION_ROUTE_ID = '/$workspaceName/_auth/sessions/$sessionId';

/* Top offset for the session drawer's left-edge drag zone: it must clear the
   chrome above the conversation so the header back button and the horizontally
   scrolling tab strip stay tappable. = BaseHeader native height
   (`3.5rem + safe-area-top`, see page-headers/base-header.tsx) + SessionTabBar
   height (its `h-9` tablist = `2.25rem`). The ~1px tab-bar border is ignored
   (the strip would cover only that hairline, never the tabs themselves). */
const SESSION_DRAWER_BODY_TOP_INSET = 'calc(3.5rem + 2.25rem + var(--safe-area-top))';

type MobileChatSearch = {
  context?: MobileWorkspaceBaseContext['context'];
  machine?: string;
  project?: string;
  repo?: string;
};

function getMobileBaseChatSearch(base: MobileWorkspaceBaseContext): MobileChatSearch {
  if (base.context === 'local') {
    return {
      context: 'local',
      ...(base.machine && base.project ? { machine: base.machine, project: base.project } : {}),
    };
  }

  if (base.context === 'github') {
    return {
      context: 'github',
      ...(base.repo ? { repo: base.repo } : {}),
    };
  }

  if (base.context === 'chat') {
    return { context: 'chat' };
  }

  return {};
}

/**
 * Mobile workspace stack: home/project landing as a persistent base, with the
 * session detail page layered on top as a right-sliding drawer.
 *
 * WHY this shape (and not plain route swaps): on mobile we want the
 * home/project ↔ session-detail relationship to feel exactly like the
 * session-detail ↔ PR relationship — push a new surface on top, swipe/back to
 * pop it, and *see the layer underneath* during the transition. That only
 * works if the underlying page stays mounted. So:
 *
 *   - The `/chat` and `/sessions/$sessionId` routes both render `null` on
 *     mobile (see those route files); this component owns the rendering for
 *     both. Because it stays mounted across the chat↔session navigation, the
 *     base `ChatLanding` instance is never torn down when you open a session —
 *     its scroll position and state survive, and it is genuinely visible
 *     beneath the session drawer.
 *   - The session overlay reuses the same Vaul right-drawer the PR view uses,
 *     so the open/close animation, interactive swipe-back, and "reveal the
 *     layer beneath" behavior are identical by construction. Vaul's drag is
 *     gated to a left-edge zone (the rest is `data-vaul-no-drag`) so only an
 *     edge swipe goes back; see `VaulDrawerBody` below.
 *
 * Base context: while `/chat` is the active route we read its search live (no
 * flash when deep-linking to a project page). Once the user drills into a
 * session the chat search is gone from the URL, so we fall back to the
 * remembered `mobileWorkspaceBaseContextAtom` (written by the chat route) so
 * the base keeps showing the page the session was opened from.
 */
export function MobileWorkspaceStack({ workspaceName }: { workspaceName: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const rememberedBase = useAtomValue(mobileWorkspaceBaseContextAtom);

  // Live chat search when on `/chat`; undefined on a session route.
  const liveChatSearch = useSearch({ from: CHAT_ROUTE_ID, shouldThrow: false });
  const base = liveChatSearch ?? rememberedBase;

  const sessionParams = useParams({ from: SESSION_ROUTE_ID, shouldThrow: false });
  const sessionSearch = useSearch({ from: SESSION_ROUTE_ID, shouldThrow: false });
  const sessionId = sessionParams?.sessionId as SessionId | undefined;
  const open = sessionId != null;

  // Keep the last opened session's props sticky so the drawer still renders its
  // content while it slides *out* (the route — and thus `sessionId` — is gone
  // the instant we navigate back, but Vaul keeps the content mounted for the
  // close animation; without this the panel would animate out blank).
  const lastSessionRef = useRef<{
    id: SessionId;
    tab?: string;
    pr?: number;
    browser?: boolean;
  } | null>(null);
  if (sessionId) {
    lastSessionRef.current = {
      id: sessionId,
      tab: sessionSearch?.tab,
      pr: sessionSearch?.pr,
      browser: sessionSearch?.browser,
    };
  }
  const rendered = lastSessionRef.current;

  const handleClose = () => {
    // Do not use raw history.back() here. PR/browser drawers can push then
    // replace same-session history entries; popping one keeps `sessionId`
    // present, so Vaul has already written a half-open transform but controlled
    // `open` never becomes false. Replace the session entry with the remembered
    // base route so the drawer always leaves the session route.
    void router.navigate({
      to: '/$workspaceName/chat',
      params: { workspaceName },
      search: getMobileBaseChatSearch(base),
      replace: true,
    });
  };

  return (
    <>
      <ChatLanding
        workspaceSlug={workspaceName}
        preSelectedContext={base.context}
        preSelectedMachine={base.machine}
        preSelectedProject={base.project}
        preSelectedRepo={base.repo}
      />
      {/* Enable the shared Drawer's native keyboard handling. ui/drawer.tsx
         uses a live viewport bottom inset on non-iOS side drawers, supporting
         both resizing WebViews and overlay keyboards without caching a shrunk
         height. iOS retains Vaul repositioning. Mobile web leaves layout to the
         browser (`interactive-widget=resizes-content`); Vaul's cached height
         previously left the composer lifted after keyboard dismissal (#2761). */}
      <Drawer
        direction="right"
        repositionInputs={isNativeAppShell()}
        open={open}
        onOpenChange={(next) => {
          if (!next) handleClose();
        }}
      >
        {/* Do not apply root-level keyboard padding here. The session composer
           already lifts itself with `mb-[var(--native-keyboard-height)]`; adding
           the same offset on this portal'd drawer would stack both offsets and
           push the composer up by roughly two keyboard heights. */}
        <DrawerContent
          className="safe-areas w-full! max-w-none! inset-0 border-0 border-l-0! rounded-none"
          data-sidebar-swipe-open-disabled
        >
          <DrawerTitle className="sr-only">
            {t('sessions.prTab.conversation', 'Conversation')}
          </DrawerTitle>
          {/* Edge-only interactive back: Vaul drives the drag but only from the
             left-edge zone (`topInset` clears the header + tab bar so the back
             button and tabs stay tappable). The session content is no-drag, so a
             center pan just scrolls/pans — code blocks, tables, and the image
             viewer never fight dismissal. See VaulDrawerBody. */}
          <VaulDrawerBody topInset={SESSION_DRAWER_BODY_TOP_INSET}>
            {rendered && (
              <AppThemeShell>
                <SessionDetail
                  sessionId={rendered.id}
                  urlTab={rendered.tab}
                  /* Nested PR/Browser drawers are themselves Vaul portals on
                     `document.body`. While this session drawer is closing we
                     still sticky-mount SessionDetail so the conversation can
                     slide out, but we must clear nested surface URL flags —
                     otherwise an open Browser/PR stays on top of Home for the
                     exit animation and flashes a few frames. */
                  urlPrNumber={open ? rendered.pr : undefined}
                  urlBrowser={open ? rendered.browser : false}
                  onMobileBack={handleClose}
                />
              </AppThemeShell>
            )}
          </VaulDrawerBody>
        </DrawerContent>
      </Drawer>
    </>
  );
}
