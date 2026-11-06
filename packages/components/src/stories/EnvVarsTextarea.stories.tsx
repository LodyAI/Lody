import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { EnvVarsTextarea } from '@/components/settings/env-vars-textarea';
const sceneStyles = stylex.create({
  stack: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 4)',
    },
  },
  compactStack: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 2)',
    },
  },
});

const storyLayoutStyles = stylex.create({
  canvas: {
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    padding: 'calc(var(--spacing) * 4)',
  },
  caption: {
    'margin-bottom': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
  },
  caption2: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
  caption3: {
    'margin-top': 'calc(var(--spacing) * 4)',
    'margin-bottom': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-medium)',
    color: 'hsl(var(--destructive) / 1)',
  },
  caption4: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--destructive) / 1)',
  },
  caption5: {
    'margin-bottom': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  caption6: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

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
      <div {...stylex.props(sceneStyles.stack)}>
        <EnvVarsTextarea value={env} onChange={setEnv} onError={setErrors} />
        <div {...stylex.props(storyLayoutStyles.canvas)}>
          <p {...stylex.props(storyLayoutStyles.caption)}>Parsed Values:</p>
          <pre {...stylex.props(storyLayoutStyles.caption2)}>{JSON.stringify(env, null, 2)}</pre>
          {errors.length > 0 && (
            <>
              <p {...stylex.props(storyLayoutStyles.caption3)}>Errors:</p>
              <pre {...stylex.props(storyLayoutStyles.caption4)}>
                {JSON.stringify(errors, null, 2)}
              </pre>
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
        <p {...stylex.props(storyLayoutStyles.caption5)}>
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
      <div {...stylex.props(sceneStyles.compactStack)}>
        <p {...stylex.props(storyLayoutStyles.caption6)}>
          Lines starting with # are treated as comments and ignored:
        </p>
        <EnvVarsTextarea value={env} onChange={setEnv} />
      </div>
    );
  },
};
