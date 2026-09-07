/** @type {import('tailwindcss').Config} */
module.exports = {
  future: {
    hoverOnlyWhenSupported: true,
  },
  theme: {
    extend: {
      borderRadius: {
        lg: 'var(--radius-lg)',
        md: 'var(--radius-md)',
        sm: 'var(--radius-sm)',
      },
      spacing: {
        control: 'var(--control-h)',
        'control-ios': 'var(--control-h-ios)',
        'safe-bottom': 'env(safe-area-inset-bottom, 0px)',
        'safe-top': 'env(safe-area-inset-top, 0px)',
        'safe-left': 'env(safe-area-inset-left, 0px)',
        'safe-right': 'env(safe-area-inset-right, 0px)',
      },
      transitionDuration: {
        1: 'var(--dur-1)',
        2: 'var(--dur-2)',
      },
      transitionTimingFunction: {
        pro: 'var(--ease)',
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        popover: 'var(--shadow-popover)',
      },
      minHeight: {
        'screen-dynamic': '100dvh',
        'screen-small': '100svh',
        'screen-large': '100lvh',
      },
      height: {
        'screen-dynamic': '100dvh',
        'screen-small': '100svh',
        'screen-large': '100lvh',
      },
      width: {
        'search-dialog': 'min(90vw, 500px)',
        'search-dialog-item': 'calc(min(90vw, 500px) - 1rem)',
      },
      colors: {
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        highlight: {
          DEFAULT: 'hsl(var(--highlight) / <alpha-value>)',
          foreground: 'hsl(var(--highlight-foreground) / <alpha-value>)',
        },
        hover: {
          DEFAULT: 'hsl(var(--hover) / <alpha-value>)',
          foreground: 'hsl(var(--hover-foreground) / <alpha-value>)',
        },
        selection: {
          DEFAULT: 'hsl(var(--selection) / <alpha-value>)',
          foreground: 'hsl(var(--selection-foreground) / <alpha-value>)',
          inactive: 'hsl(var(--selection-inactive) / <alpha-value>)',
          'inactive-foreground': 'hsl(var(--selection-inactive-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        border: 'hsl(var(--border) / <alpha-value>)',
        input: {
          DEFAULT: 'hsl(var(--input) / <alpha-value>)',
          // Fill of an editable control. Separate from `input.DEFAULT`, which
          // doubles as a muted chip/pill fill and may recess below the page.
          field: 'hsl(var(--input-field) / <alpha-value>)',
          foreground: 'hsl(var(--input-foreground) / <alpha-value>)',
          placeholder: 'hsl(var(--input-placeholder) / <alpha-value>)',
          border: 'hsl(var(--input-border) / <alpha-value>)',
        },
        'switch-track': 'hsl(var(--switch-track) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        chart: {
          1: 'hsl(var(--chart-1) / <alpha-value>)',
          2: 'hsl(var(--chart-2) / <alpha-value>)',
          3: 'hsl(var(--chart-3) / <alpha-value>)',
          4: 'hsl(var(--chart-4) / <alpha-value>)',
          5: 'hsl(var(--chart-5) / <alpha-value>)',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background) / <alpha-value>)',
          foreground: 'hsl(var(--sidebar-foreground) / <alpha-value>)',
          'foreground-muted': 'hsl(var(--sidebar-foreground-muted) / <alpha-value>)',
          primary: 'hsl(var(--sidebar-primary) / <alpha-value>)',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground) / <alpha-value>)',
          highlight: 'hsl(var(--sidebar-highlight) / <alpha-value>)',
          'highlight-foreground': 'hsl(var(--sidebar-highlight-foreground) / <alpha-value>)',
          hover: 'hsl(var(--sidebar-hover) / <alpha-value>)',
          'hover-foreground': 'hsl(var(--sidebar-hover-foreground) / <alpha-value>)',
          accent: 'hsl(var(--sidebar-accent) / <alpha-value>)',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground) / <alpha-value>)',
          selection: 'hsl(var(--sidebar-selection) / <alpha-value>)',
          'selection-foreground': 'hsl(var(--sidebar-selection-foreground) / <alpha-value>)',
          border: 'hsl(var(--sidebar-border) / <alpha-value>)',
          ring: 'hsl(var(--sidebar-ring) / <alpha-value>)',
        },
        'button-hover': 'hsl(var(--button-hover) / <alpha-value>)',
        'bottom-bar': {
          DEFAULT: 'hsl(var(--bottom-bar) / <alpha-value>)',
          foreground: 'hsl(var(--bottom-bar-foreground) / <alpha-value>)',
        },
        tab: {
          bar: 'hsl(var(--tab-bar) / <alpha-value>)',
          active: 'hsl(var(--tab-active) / <alpha-value>)',
          'active-foreground': 'hsl(var(--tab-active-foreground) / <alpha-value>)',
          inactive: 'hsl(var(--tab-inactive) / <alpha-value>)',
          'inactive-foreground': 'hsl(var(--tab-inactive-foreground) / <alpha-value>)',
          hover: 'hsl(var(--tab-hover) / <alpha-value>)',
          'hover-foreground': 'hsl(var(--tab-hover-foreground) / <alpha-value>)',
          border: 'hsl(var(--tab-border) / <alpha-value>)',
          'active-accent': 'hsl(var(--tab-active-accent) / <alpha-value>)',
        },
        code: {
          DEFAULT: 'hsl(var(--code-background) / <alpha-value>)',
          foreground: 'hsl(var(--code-foreground) / <alpha-value>)',
          border: 'hsl(var(--code-border) / <alpha-value>)',
          added: 'hsl(var(--code-added) / <alpha-value>)',
          removed: 'hsl(var(--code-removed) / <alpha-value>)',
        },
        status: {
          info: 'hsl(var(--status-info) / <alpha-value>)',
          success: 'hsl(var(--status-success) / <alpha-value>)',
          warning: 'hsl(var(--status-warning) / <alpha-value>)',
          danger: 'hsl(var(--status-danger) / <alpha-value>)',
          merged: 'hsl(var(--status-merged) / <alpha-value>)',
        },
        github: {
          open: 'hsl(var(--github-open) / <alpha-value>)',
          merged: 'hsl(var(--github-merged) / <alpha-value>)',
          closed: 'hsl(var(--github-closed) / <alpha-value>)',
          draft: 'hsl(var(--github-draft) / <alpha-value>)',
          addition: 'hsl(var(--github-addition) / <alpha-value>)',
          deletion: 'hsl(var(--github-deletion) / <alpha-value>)',
        },
        'modified-file': 'hsl(var(--modified-file) / <alpha-value>)',
        'primary-content': 'hsl(var(--primary-content) / <alpha-value>)',
        syntax: {
          keyword: 'hsl(var(--syntax-keyword) / <alpha-value>)',
          string: 'hsl(var(--syntax-string) / <alpha-value>)',
          number: 'hsl(var(--syntax-number) / <alpha-value>)',
          comment: 'hsl(var(--syntax-comment) / <alpha-value>)',
          function: 'hsl(var(--syntax-function) / <alpha-value>)',
          variable: 'hsl(var(--syntax-variable) / <alpha-value>)',
          title: 'hsl(var(--syntax-title) / <alpha-value>)',
          attr: 'hsl(var(--syntax-attr) / <alpha-value>)',
          builtin: 'hsl(var(--syntax-builtin) / <alpha-value>)',
        },
      },
      keyframes: {
        'accordion-down': {
          from: {
            height: '0',
          },
          to: {
            height: 'var(--radix-accordion-content-height)',
          },
        },
        'accordion-up': {
          from: {
            height: 'var(--radix-accordion-content-height)',
          },
          to: {
            height: '0',
          },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'system-ui',
          'Noto Sans SC',
          'PingFang SC',
          'Microsoft YaHei',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'SF Mono',
          'Monaco',
          'Inconsolata',
          'Fira Code',
          'Droid Sans Mono',
          'Source Code Pro',
          'monospace',
        ],
      },
    },
  },
  plugins: [
    require('@tailwindcss/container-queries'),
    function ({ addUtilities, addComponents }) {
      addUtilities({
        '.app-region-drag': {
          '-webkit-app-region': 'drag',
        },
        '.app-region-no-drag': {
          '-webkit-app-region': 'no-drag',
          'pointer-events': 'auto',
        },
      });
      addComponents({
        '.app-region-drag :is(button, a, input, textarea, select)': {
          '-webkit-app-region': 'no-drag',
          'pointer-events': 'auto',
        },
      });
    },
  ],
};
