import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { InlinePageReview } from './MobileNewChatSheet.stories';
import { SessionConversationStoryHarness } from './SessionConversationPage.stories';
import { SettingsStoryProviders } from './settings-story-shell';
import { ForceMobileLayoutProvider } from '@/hooks/use-mobile';
import {
  getSessionCreationNavigation,
  useMobileComposerPresentation,
} from '@/components/chat/submission/use-composer-navigation-focus';
import { Drawer, DrawerContent, DrawerTitle } from '@/ui/drawer';
import { VaulDrawerBody } from '@/components/mobile/vaul-drawer-edge-back-zone';

/** Real page/composer/message renderers, with synthetic workspace data. The
 * route handoff uses the production navigation and presentation hooks. */
function TransitionSurface({ deferred = false }: { deferred?: boolean }) {
  const router = useRouter();
  const params = useParams({ strict: false }) as { sessionId?: string };
  const presentation = useMobileComposerPresentation(params.sessionId);
  const [ready, setReady] = useState(!deferred);
  const [presentedSession, setPresentedSession] = useState<string>();
  const { onPresented } = presentation;
  const acknowledge = useCallback(() => {
    setPresentedSession(params.sessionId);
    onPresented();
  }, [params.sessionId, onPresented]);
  useEffect(() => {
    const complete = () => setReady(true);
    const normalize = () => {
      if (params.sessionId)
        void router.navigate({
          to: '/$workspaceName/sessions/$sessionId',
          params: { workspaceName: 'storybook', sessionId: params.sessionId },
          search: { tab: params.sessionId },
          replace: true,
          state: (previous) => previous,
        });
    };
    window.addEventListener('storybook:session-ready', complete);
    window.addEventListener('storybook:normalize-session-url', normalize);
    return () => {
      window.removeEventListener('storybook:session-ready', complete);
      window.removeEventListener('storybook:normalize-session-url', normalize);
    };
  }, [router, params.sessionId]);
  const [sent, setSent] = useState<{ text: string; model: string } | null>(null);
  return (
    <>
      {(!params.sessionId || presentedSession !== params.sessionId) && (
        <InlinePageReview
          initialText="请检查移动端发送消息的布局。"
          submissionPending={Boolean(sent)}
          onSend={(text, model) => {
            setSent({ text, model });
            void router.navigate(getSessionCreationNavigation('storybook', 'created', true));
          }}
        />
      )}
      {sent && (
        <Drawer
          key={presentation.key}
          defaultOpen={presentation.defaultOpen}
          direction="right"
          open={!!params.sessionId}
          onOpenChange={(open) => {
            if (!open)
              void router.navigate({
                to: '/$workspaceName/chat',
                params: { workspaceName: 'storybook' },
                replace: true,
              });
          }}
        >
          {ready && (
            <DrawerContent
              skipOpenAnimation={!!params.sessionId && presentation.skipOpenAnimation}
              className="safe-areas w-full! max-w-none! inset-0 border-0 border-l-0! rounded-none"
            >
              <DrawerTitle className="sr-only">Conversation</DrawerTitle>
              <VaulDrawerBody topInset="3rem">
                <SessionConversationStoryHarness
                  onPresented={acknowledge}
                  state="idle"
                  frame="mobile"
                  embedded
                  composerText=""
                  repoFullName="loro-dev/loro"
                  branchName="main"
                  sessionTitle="移动端消息布局"
                  firstUserMessage={sent.text}
                  composerModelLabel={sent.model}
                />
              </VaulDrawerBody>
            </DrawerContent>
          )}
        </Drawer>
      )}
    </>
  );
}
function TransitionReview({ deferred = false }: { deferred?: boolean }) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: () => <TransitionSurface deferred={deferred} /> });
    const chat = createRoute({
      getParentRoute: () => root,
      path: '/$workspaceName/chat',
      component: () => null,
    });
    const session = createRoute({
      getParentRoute: () => root,
      path: '/$workspaceName/sessions/$sessionId',
      component: () => null,
    });
    return createRouter({
      routeTree: root.addChildren([chat, session]),
      history: createMemoryHistory({ initialEntries: ['/storybook/chat'] }),
    });
  }, [deferred]);
  return (
    <ForceMobileLayoutProvider force>
      <SettingsStoryProviders>
        <RouterProvider router={router} />
      </SettingsStoryProviders>
    </ForceMobileLayoutProvider>
  );
}
const meta = {
  title: 'Mobile/NewChatTransition',
  component: TransitionReview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof TransitionReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SendInPlace: Story = {};

export const DeferredSendInPlace: Story = { args: { deferred: true } };
