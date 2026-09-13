import type { SessionHistory } from '@lody/shared';
import type { ConversationView } from './types';

/** Export the authoritative snapshot, never stitch window caches or projections. */
export function readConversationHistory(view: ConversationView): Promise<SessionHistory[]> {
  return view.readAll();
}
