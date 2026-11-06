'use client';

import * as stylex from '@stylexjs/stylex';
import {
  LanguageSelect,
  LanguageSelectText,
} from 'fumadocs-ui/layouts/shared/slots/language-select';
import { ChevronDown, Languages } from 'lucide-react';

const styles = stylex.create({
  wrapper: { marginBottom: 'calc(var(--spacing) * 4)' },
  trigger: {
    height: 'calc(var(--spacing) * 9)',
    width: '100%',
    justifyContent: 'flex-start',
    gap: 'calc(var(--spacing) * 2)',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: {
      default: 'color-mix(in oklab, var(--color-fd-secondary) 60%, transparent)',
      '@media (hover: hover)': { ':hover': 'var(--color-fd-accent)' },
    },
    paddingInline: 'calc(var(--spacing) * 2.5)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: {
      default: 'var(--color-fd-muted-foreground)',
      '@media (hover: hover)': { ':hover': 'var(--color-fd-accent-foreground)' },
    },
  },
  languageIcon: { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
  label: {
    minWidth: 0,
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'start',
  },
  chevron: {
    marginInlineStart: 'auto',
    width: 'calc(var(--spacing) * 3.5)',
    height: 'calc(var(--spacing) * 3.5)',
    opacity: 0.7,
  },
});

export function DocsTocLanguageSelect() {
  return (
    <div {...stylex.props(styles.wrapper)}>
      <LanguageSelect variant="secondary" {...stylex.props(styles.trigger)}>
        <Languages aria-hidden="true" {...stylex.props(styles.languageIcon)} />
        <LanguageSelectText {...stylex.props(styles.label)} />
        <ChevronDown aria-hidden="true" {...stylex.props(styles.chevron)} />
      </LanguageSelect>
    </div>
  );
}
