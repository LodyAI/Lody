import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useRef } from 'react';
import { renderBootFailure, type BootFailureOptions } from '@/lib/boot-failure';

/**
 * The pre-React boot screen. It is plain DOM with its own stylesheet, so the
 * story hands it a node and lets it draw, the way `main.tsx` does on a failed
 * boot. Its palette follows the stored theme or the OS, not Storybook's toolbar.
 */
function BootFailurePreview({ error, options }: { error: Error; options: BootFailureOptions }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) renderBootFailure(ref.current, error, options);
  }, [error, options]);
  return <div ref={ref} />;
}

function stylexError(): Error {
  const error = new Error(
    "Unexpected 'stylex.create' call at runtime. Styles must be compiled by '@stylexjs/babel-plugin'."
  );
  error.stack = `Error: ${error.message}\n    at Object.create (stylex.js:12:11)\n    at status-page.tsx:24:22`;
  return error;
}

const BUILD_INFO = {
  Runtime: 'electron',
  Build: 'ff272419',
  BuildDate: '2026-09-25',
  Platform: 'darwin',
};

const meta = {
  title: 'Pages/BootFailure',
  component: BootFailurePreview,
  parameters: { layout: 'fullscreen' },
  args: { error: stylexError(), options: { buildInfo: BUILD_INFO } },
} satisfies Meta<typeof BootFailurePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The app never mounted. */
export const Boot: Story = {};

/** A chunk did not load: the one failure whose fix the page can name. */
export const ChunkLoad: Story = {
  args: {
    error: new TypeError(
      'Failed to fetch dynamically imported module: app://renderer/assets/session-detail-3f9a.js'
    ),
  },
};

/** The main process loaded `recovery.html` after the renderer died. */
export const Recovery: Story = {
  args: {
    error: new Error('Render process gone: crashed (exit code 133)'),
    options: { buildInfo: { ...BUILD_INFO, Runtime: 'electron:recovery' }, surface: 'recovery' },
  },
};
