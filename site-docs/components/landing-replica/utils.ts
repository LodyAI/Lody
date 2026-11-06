import { clsx, type ClassValue } from 'clsx';

/** Join StyleX classes and the replica's ordinary CSS hooks. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
