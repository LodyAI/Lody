'use client';

import React, { useState } from 'react';

import { Check, Copy } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';
import * as stylex from '@stylexjs/stylex';
import { themeDuration, themeEasing, themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  layout: { position: 'relative', flexShrink: 0 },
  accessibleLabel: {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  glyph: {
    width: themeSpace[2],
    height: themeSpace[2],
    position: 'absolute',
    inset: 0,
    margin: 'auto',
    transitionProperty: 'all',
    transitionDuration: themeDuration[200],
    transitionTimingFunction: themeEasing['in-out'],
  },
  shown: { opacity: 1, filter: 'none', scale: '100% 100%' },
  hidden: { opacity: 0, filter: 'blur(var(--blur-xs, 4px))', scale: '75% 75%' },
});

export const CopyButton = ({
  value,
  className,
  ...props
}: {
  value: string;
  className?: string;
} & React.ComponentProps<'button'>) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!value) return;
    e.stopPropagation();
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  return (
    <Button
      variant="ghost"
      data-state={copied ? 'copied' : 'not-copied'}
      size="small"
      {...props}
      className={cn(stylex.props(styles.layout).className, className)}
      onClick={handleCopy}
    >
      <span {...stylex.props(styles.accessibleLabel)}>Copy</span>
      <Check
        {...stylex.props(styles.glyph, copied ? styles.shown : styles.hidden)}
        aria-label="Copied"
      />
      <Copy
        {...stylex.props(styles.glyph, !copied ? styles.shown : styles.hidden)}
        aria-label="Copy"
      />
    </Button>
  );
};
