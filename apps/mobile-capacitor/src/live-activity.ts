import { registerPlugin } from '@capacitor/core';
import type {
  LodyLiveActivityBridge,
  LodyLiveActivityPermissionActionsConfig,
  LodyLiveActivitySyncPayload,
  LodyLiveActivitySyncResult,
} from '@lody/components/hooks/use-lody-live-activity';

const LodyLiveActivity = registerPlugin<LodyLiveActivityBridge>('LodyLiveActivity');

export function initLiveActivityBridge(): void {
  window.__LODY_LIVE_ACTIVITY__ = {
    syncConversationSummary(
      payload: LodyLiveActivitySyncPayload
    ): Promise<LodyLiveActivitySyncResult> {
      return LodyLiveActivity.syncConversationSummary(payload);
    },
    endConversationSummary(payload: { activityId: string }): Promise<void> {
      return LodyLiveActivity.endConversationSummary(payload);
    },
    setupPushLiveActivities(): Promise<void> {
      return LodyLiveActivity.setupPushLiveActivities?.() ?? Promise.resolve();
    },
    configurePermissionActions(payload: LodyLiveActivityPermissionActionsConfig): Promise<void> {
      return LodyLiveActivity.configurePermissionActions?.(payload) ?? Promise.resolve();
    },
  };
}
