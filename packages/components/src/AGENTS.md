# `@lody/components` source guidelines

Parent `AGENTS.md` files also apply.

## Workspace transitions

- Authenticated workspace switches keep `MainLayout` mounted: the sidebar and
  workspace identity are stable chrome, while the content pane shows a scoped
  placeholder until route, runtime, and doc-meta ownership agree. Pending scope
  still fails closed — never retain the previous workspace's rows or `<Outlet />`
  content — and passes `workspaceReady={false}` so workspace-owned background work
  and the mobile workspace stack do not start early. The workspace identity's
  syncing state follows that same scoped readiness, not the coarser connection
  state; an online transport does not imply that workspace data is ready.
