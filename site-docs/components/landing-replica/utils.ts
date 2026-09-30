import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Class joiner with Tailwind conflict resolution, so copied overrides win. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
