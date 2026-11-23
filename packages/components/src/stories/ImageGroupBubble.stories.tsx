import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import type { SessionId, WorkspaceId } from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms';
import { authTokenAtom } from '@/atoms/runtime';
import { ImageGroupBubble, type ImageBubbleAlign } from '@/components/ai-gui/view';

const STORY_WORKSPACE_ID = 'workspace-storybook' as WorkspaceId;
const STORY_SESSION_ID = 'session-storybook' as SessionId;
const STORY_AUTH_TOKEN = 'storybook-token';

const buildStorySvg = (label: string, from: string, to: string): string => `
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" fill="none">
    <defs>
      <linearGradient id="bg" x1="96" y1="48" x2="1184" y2="672" gradientUnits="userSpaceOnUse">
        <stop stop-color="${from}" />
        <stop offset="1" stop-color="${to}" />
      </linearGradient>
    </defs>
    <rect width="1280" height="720" rx="48" fill="url(#bg)" />
    <rect x="72" y="72" width="1136" height="576" rx="36" fill="rgba(255,255,255,0.16)" />
    <rect x="120" y="132" width="420" height="40" rx="20" fill="rgba(255,255,255,0.45)" />
    <rect x="120" y="208" width="760" height="28" rx="14" fill="rgba(255,255,255,0.35)" />
    <rect x="120" y="260" width="520" height="28" rx="14" fill="rgba(255,255,255,0.28)" />
    <rect x="120" y="360" width="320" height="180" rx="24" fill="rgba(255,255,255,0.25)" />
    <rect x="480" y="360" width="320" height="180" rx="24" fill="rgba(255,255,255,0.2)" />
    <rect x="840" y="360" width="248" height="180" rx="24" fill="rgba(255,255,255,0.16)" />
    <text
      x="120"
      y="606"
      fill="white"
      font-family="ui-sans-serif, system-ui, sans-serif"
      font-size="54"
      font-weight="700"
    >
      ${label}
    </text>
  </svg>
`;

const storyImageSeeds = [
  { label: 'Landing Page', fileName: 'landing-page.png', from: '#0f766e', to: '#0f172a' },
  { label: 'Settings Modal', fileName: 'settings-modal.png', from: '#b45309', to: '#7c2d12' },
  { label: 'Table View', fileName: 'table-view.png', from: '#2563eb', to: '#312e81' },
  { label: 'Mobile Layout', fileName: 'mobile-layout.png', from: '#be185d', to: '#701a75' },
  { label: 'Dark Theme', fileName: 'dark-theme.png', from: '#1d4ed8', to: '#0f172a' },
  { label: 'Font 12px', fileName: 'font-12.png', from: '#047857', to: '#134e4a' },
  { label: 'Font 16px', fileName: 'font-16.png', from: '#7c3aed', to: '#3b0764' },
  { label: 'Font 20px', fileName: 'font-20.png', from: '#c2410c', to: '#7c2d12' },
  { label: 'Composer', fileName: 'composer.png', from: '#0891b2', to: '#164e63' },
  { label: 'Session List', fileName: 'session-list.png', from: '#4d7c0f', to: '#1a2e05' },
  { label: 'Permission', fileName: 'permission.png', from: '#a16207', to: '#422006' },
  { label: 'Diff View', fileName: 'diff-view.png', from: '#9333ea', to: '#2e1065' },
  { label: 'Terminal', fileName: 'terminal.png', from: '#334155', to: '#020617' },
] as const;

const storySvgByImageId = new Map<string, string>(
  storyImageSeeds.map((seed, index) => [
    `img-${index + 1}`,
    buildStorySvg(seed.label, seed.from, seed.to),
  ])
);

const fallbackStorySvg = buildStorySvg('Image Preview', '#475569', '#0f172a');

const getRequestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

const getStoryImageIdFromRequest = (input: RequestInfo | URL): string | null => {
  const decoded = decodeURIComponent(getRequestUrl(input));
  // `/api/workspaces/<id>/session-images/<sessionId>/<imageId>` (see
  // `getSessionImageDownloadApiPath`), with the thumbnail query string appended.
  const match = decoded.match(/\/session-images\/[^/]+\/([^/?]+)/);
  return match?.[1] ?? null;
};

const installStoryImageFetchMock = (): void => {
  const marker = '__lodyImageGroupStoryFetchMockInstalled__';
  const globalRecord = globalThis as typeof globalThis & Record<string, unknown>;
  if (globalRecord[marker]) {
    return;
  }

  const originalFetch = globalThis.fetch?.bind(globalThis);
  if (!originalFetch) {
    return;
  }

  globalRecord[marker] = true;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const imageId = getStoryImageIdFromRequest(input);
    if (!imageId) {
      return await originalFetch(input, init);
    }

    const svgMarkup = storySvgByImageId.get(imageId) ?? fallbackStorySvg;
    return new Response(new Blob([svgMarkup], { type: 'image/svg+xml' }), {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  };
};

installStoryImageFetchMock();

const storyImages = storyImageSeeds.map((seed, index) => ({
  imageId: `img-${index + 1}`,
  mimeType: 'image/png',
  fileName: seed.fileName,
  sizeBytes: 180_000 - index * 3_000,
  width: 1280,
  height: 720,
}));

type StoryPreviewProps = {
  align: ImageBubbleAlign;
  /** 1 through `storyImages.length` — a long group is the wrapping case. */
  imageCount: number;
  speaker: 'assistant' | 'user';
};

const createStoryStore = () => {
  const store = createStore();
  store.set(currentWorkspaceIdAtom, STORY_WORKSPACE_ID);
  store.set(authTokenAtom, STORY_AUTH_TOKEN);
  return store;
};

function StoryPreview({ align, imageCount, speaker }: StoryPreviewProps) {
  const store = useMemo(() => createStoryStore(), []);
  const content = {
    type: 'image_group' as const,
    images: storyImages.slice(0, imageCount),
  };
  const bubbleTone =
    speaker === 'user'
      ? 'border-primary/20 bg-primary/10 dark:border-primary/30 dark:bg-primary/20'
      : 'border-border/70 bg-card';

  return (
    <Provider store={store}>
      <div className="mx-auto flex w-full max-w-4xl justify-center p-6">
        <div className="w-full max-w-[42rem] rounded-[28px] border border-dashed border-border/70 bg-muted/20 p-5">
          <div className={`flex w-full ${speaker === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`w-full max-w-[34rem] rounded-[24px] border p-4 shadow-xs ${bubbleTone}`}
            >
              <ImageGroupBubble
                content={content}
                sessionId={STORY_SESSION_ID}
                messageId="storybook-image-group"
                itemIndex={0}
                align={align}
              />
            </div>
          </div>
        </div>
      </div>
    </Provider>
  );
}

const meta = {
  title: 'AI/ImageGroupBubble',
  component: StoryPreview,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  args: {
    align: 'start',
    imageCount: 1,
    speaker: 'assistant',
  },
} satisfies Meta<typeof StoryPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AssistantSingle: Story = {};

export const UserSingle: Story = {
  args: {
    align: 'end',
    speaker: 'user',
  },
};

export const TwoImageGrid: Story = {
  args: {
    imageCount: 2,
  },
};

export const ThreeImageGrid: Story = {
  args: {
    align: 'end',
    imageCount: 3,
    speaker: 'user',
  },
};

export const FourImageGrid: Story = {
  args: {
    imageCount: 4,
  },
};

/**
 * The case a fixed two-column grid used to turn into a tall narrow tower: a long
 * agent attachment group wraps along the conversation width instead.
 */
export const ThirteenImageWrap: Story = {
  args: {
    imageCount: 13,
  },
};

export const ThirteenImageWrapFromUser: Story = {
  args: {
    align: 'end',
    imageCount: 13,
    speaker: 'user',
  },
};
