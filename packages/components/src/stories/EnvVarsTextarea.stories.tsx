import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { EnvVarsTextarea } from '@/components/settings/env-vars-textarea';
const storyLayout = stylex.create({
  frame: {
    width: '400px',
  },
  frame2: {
    width: '400px',
    'border-radius': 'var(--radius-lg)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 4)',
  },
});

/**
 * EnvVarsTextarea component stories.
 * This component allows users to input environment variables in KEY=VALUE format.
 */
const meta = {
  title: 'Settings/EnvVarsTextarea',
  component: EnvVarsTextarea,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof EnvVarsTextarea>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default empty state
 */
export const Empty: Story = {
  args: {
    value: {},
    onChange: () => {},
  },
};

/**
 * With initial values
 */
export const WithValues: Story = {
  args: {
    value: {
      API_KEY: 'sk-1234567890',
      DATABASE_URL: 'postgres://localhost:5432/mydb',
      DEBUG: 'true',
    },
    onChange: () => {},
  },
};

/**
 * Interactive example with state management
 */
export const Interactive: Story = {
  args: {
    value: {},
    onChange: () => {},
  },
  render: function InteractiveStory() {
    const [env, setEnv] = useState<Record<string, string>>({
      NODE_ENV: 'development',
      PORT: '3000',
    });
    const [errors, setErrors] = useState<Array<{ line: number; message: string }>>([]);

    return (
      <div className="space-y-4">
        <EnvVarsTextarea value={env} onChange={setEnv} onError={setErrors} />
        <div className="rounded-md border p-4">
          <p className="mb-2 text-sm font-medium">Parsed Values:</p>
          <pre className="text-xs">{JSON.stringify(env, null, 2)}</pre>
          {errors.length > 0 && (
            <>
              <p className="mb-2 mt-4 text-sm font-medium text-destructive">Errors:</p>
              <pre className="text-xs text-destructive">{JSON.stringify(errors, null, 2)}</pre>
            </>
          )}
        </div>
      </div>
    );
  },
};

/**
 * With validation errors
 */
export const WithErrors: Story = {
  args: {
    value: {},
    onChange: () => {},
  },
  render: function ErrorStory() {
    const [env, setEnv] = useState<Record<string, string>>({});

    return (
      <EnvVarsTextarea
        value={env}
        onChange={setEnv}
        // Pre-populate with invalid content by using initial text
      />
    );
  },
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <p className="mb-2 text-sm text-muted-foreground">
          Try entering invalid lines like &quot;INVALID&quot; (no =) or &quot;123ABC=value&quot;
          (invalid key)
        </p>
        <Story />
      </div>
    ),
  ],
};

/**
 * Without label
 */
export const WithoutLabel: Story = {
  args: {
    value: {
      SECRET: 'my-secret-value',
    },
    onChange: () => {},
    showLabel: false,
  },
};

/**
 * Custom label
 */
export const CustomLabel: Story = {
  args: {
    value: {},
    onChange: () => {},
    label: 'Custom Environment Variables',
  },
};

/**
 * With more rows
 */
export const LargeTextarea: Story = {
  args: {
    value: {
      VAR_1: 'value1',
      VAR_2: 'value2',
      VAR_3: 'value3',
      VAR_4: 'value4',
      VAR_5: 'value5',
    },
    onChange: () => {},
    rows: 8,
  },
};

/**
 * Disabled state
 */
export const Disabled: Story = {
  args: {
    value: {
      READONLY_VAR: 'cannot-edit',
    },
    onChange: () => {},
    disabled: true,
  },
};

/**
 * Dark mode
 */
export const DarkMode: Story = {
  args: {
    value: {
      DARK_MODE: 'enabled',
      THEME: 'dark',
    },
    onChange: () => {},
  },
  decorators: [
    (Story) => (
      <div className={clsx(stylex.props(storyLayout.frame2).className, 'dark')}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    backgrounds: {
      default: 'dark',
    },
  },
};

/**
 * With comments example
 */
export const WithComments: Story = {
  args: {
    value: {},
    onChange: () => {},
  },
  render: function CommentsStory() {
    const [env, setEnv] = useState<Record<string, string>>({});

    // We can't directly set the text, so we'll show what happens when comments are used
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Lines starting with # are treated as comments and ignored:
        </p>
        <EnvVarsTextarea value={env} onChange={setEnv} />
      </div>
    );
  },
};
