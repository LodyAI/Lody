/** Document-safe card geometry shared by the boot shell and the React workspace. */
export const WORKSPACE_FRAME_CSS = `
.lody-workspace-card {
  box-sizing: border-box;
  margin: var(--lody-frame-gutter, 8px) var(--lody-frame-gutter, 8px) var(--lody-frame-gutter, 8px) var(--lody-frame-left, 0px);
  border: 0.5px solid var(--lody-frame-border, hsl(var(--border) / 0.6));
  border-radius: var(--lody-frame-radius, 10px);
  background: var(--lody-frame-canvas, hsl(var(--background)));
  box-shadow: 0 1px 2px hsl(0 0% 0% / 0.03);
}
.lody-workspace-card[data-anchored="false"] {
  margin-left: var(--lody-frame-gutter, 8px);
}
`;
