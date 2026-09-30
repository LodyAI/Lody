'use client';

import React, { useState } from 'react';

import { Check, Copy } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';

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
      className={cn('relative shrink-0', className)}
      onClick={handleCopy}
    >
      <span className="sr-only">Copy</span>
      <Check
        className={cn(
          'w-2 h-2 absolute inset-0 m-auto transition-all duration-200',
          copied ? 'opacity-100 blur-0 scale-100' : 'opacity-0 blur-xs scale-75'
        )}
        aria-label="Copied"
      />
      <Copy
        className={cn(
          'w-2 h-2 absolute inset-0 m-auto transition-all duration-200',
          !copied ? 'opacity-100 blur-0 scale-100' : 'opacity-0 blur-xs scale-75'
        )}
        aria-label="Copy"
      />
    </Button>
  );
};
