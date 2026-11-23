import { createContext, type ReactNode } from 'react';
import type { SessionFilePayload, SessionId } from '@lody/shared';
import type { SessionImageGalleryEntry } from '@/lib/session-image-gallery';

/** Read-only presentation supplies its own attachment capability, never workspace auth. */
export const SessionReadonlyContext = createContext<{
  renderImage: (entry: SessionImageGalleryEntry) => ReactNode;
  renderFiles: (files: SessionFilePayload[], sessionId: SessionId) => ReactNode;
} | null>(null);
