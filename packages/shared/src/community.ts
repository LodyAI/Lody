/**
 * A single ops-managed community QR image stored in the `LORO_DOCUMENTS` R2
 * bucket and served publicly by the server worker (same model as avatars, but
 * a fixed key instead of an opaque id so ops can rotate it in place).
 *
 * Settings → About → Join community no longer reads this: the QR now ships with
 * the app (`packages/components/src/assets/community-feishu-qr.png`) so it
 * renders offline and the OSS desktop entry makes no product-cloud request for
 * it. These constants remain the server-side contract for the hosted endpoint.
 *
 * Upload / rotate the image with wrangler (no deploy needed):
 *
 *   pnpm wrangler r2 object put loro-docs/community/wechat-group-qr \
 *     --file ./wechat-qr.png --content-type image/png --remote --env production
 *
 * (staging uses the `loro-docs-preview` bucket instead).
 */
export const COMMUNITY_WECHAT_QR_API_PATH = '/api/community/wechat-qr';
export const COMMUNITY_WECHAT_QR_OBJECT_KEY = 'community/wechat-group-qr';
// WeChat group invite codes expire and the object is re-uploaded under the
// same key, so cache briefly instead of the immutable avatar policy.
export const COMMUNITY_WECHAT_QR_CACHE_CONTROL = 'public, max-age=300';
