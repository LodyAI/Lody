export const SESSION_DETAIL_MAIN_CONTENT_ID = 'session-detail-main-content';
export const SESSION_DETAIL_EDITOR_CONTENT_ID = 'session-detail-editor-content';

export function getSessionDetailSkipTargetId(hasEditorSurface: boolean): string {
  return hasEditorSurface ? SESSION_DETAIL_EDITOR_CONTENT_ID : SESSION_DETAIL_MAIN_CONTENT_ID;
}
