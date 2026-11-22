import { registerPlugin } from '@capacitor/core';

type LodyAppStoreReviewPlugin = {
  requestReview: () => Promise<{ requested?: boolean }>;
};

type LodyAppStoreReviewBridge = {
  requestReview: () => void | Promise<void>;
};

type ReviewWindow = Window & {
  __LODY_APP_STORE_REVIEW__?: LodyAppStoreReviewBridge;
};

const LodyAppStoreReview = registerPlugin<LodyAppStoreReviewPlugin>('LodyAppStoreReview');
async function requestReview(): Promise<void> {
  try {
    await LodyAppStoreReview.requestReview();
  } catch (error) {
    console.warn('Unable to request an App Store review.', error);
  }
}

export function initAppStoreReviewBridge(): void {
  const bridge: LodyAppStoreReviewBridge = {
    requestReview,
  };
  (window as ReviewWindow).__LODY_APP_STORE_REVIEW__ = bridge;
}
