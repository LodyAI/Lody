import { Spinner } from './spinner';
import { cn } from '@/lib/utils';

interface LoadingProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Loading component with animated spinner
 */
export function Loading({ className, size = 'md' }: LoadingProps) {
  const sizeClasses = {
    sm: 'h-4 w-4',
    md: 'h-6 w-6',
    lg: 'h-8 w-8',
  };

  return (
    <div className={cn('flex items-center justify-center', className)}>
      <Spinner className={cn('text-muted-foreground', sizeClasses[size])} />
    </div>
  );
}
