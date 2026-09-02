import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { ErrorBoundaryFallback } from '@/components/error-boundary-fallback';

function crashError(): Error {
  const error = new TypeError("Cannot read properties of undefined (reading 'title')");
  error.stack = [
    "TypeError: Cannot read properties of undefined (reading 'title')",
    '    at SessionChatHeader (session-chat-interface.tsx:5192:21)',
    '    at renderWithHooks (react-dom-client.development.js:6667:22)',
  ].join('\n');
  return error;
}

const COMPONENT_STACK = [
  '    at SessionChatHeader (session-chat-interface.tsx:5192:21)',
  '    at ErrorBoundary (error-boundary.tsx:116:1)',
  '    at RootOutlet',
].join('\n');

const meta: Meta<typeof ErrorBoundaryFallback> = {
  title: 'Components/ErrorBoundaryFallback',
  component: ErrorBoundaryFallback,
  args: {
    error: crashError(),
    componentStack: COMPONENT_STACK,
    boundaryName: 'RootOutlet',
    variant: 'page',
    resetErrorBoundary: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof ErrorBoundaryFallback>;

/** Full-page crash: the whole route failed to render. */
export const Page: Story = {};

/** The boundary gave up on recovering by itself and says so. */
export const PageAfterAutomaticRetriesStopped: Story = {
  args: {
    automaticRetriesStopped: true,
  },
};

/** One panel or region failed; the surrounding layout still works. */
export const Section: Story = {
  args: {
    variant: 'section',
  },
};

/** Tight spots (headers, toolbars): one readable line, retry, and copy. */
export const Inline: Story = {
  args: {
    variant: 'inline',
  },
};

/** Hosts that opt out of details still get the recovery steps. */
export const WithoutErrorDetails: Story = {
  args: {
    showErrorDetails: false,
  },
};
