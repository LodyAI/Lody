# `@lody/components` source guidelines

Parent `AGENTS.md` files also apply.

## Public/auth route boundaries

- Public/auth pages remain ordinary TanStack file routes under the product router; do
  not add a separate React entry, root lifecycle, empty workspace provider, or URL
  dispatcher for a lightweight page. The global layout may own auth, Cloud API, i18n,
  and PostHog; `RuntimeProvider` and workspace Flock state begin at the
  `/$workspaceName` layout.
- Hosts that consume `@lody/components/router` register the TanStack Router Vite plugin
  before React with this package's routes directory and generated route tree. Keep a
  route's component local unless another route truly imports it: the plugin can then
  emit the component chunk, so a new public/auth route inherits the light closure from
  its layout without bootstrap changes.

## Keyboard navigation

- Each independently navigable list owns one `FocusScope` and one
  `useListKeyboardNavigation` call. Rows expose `data-scope-item` plus a stable
  `data-id`; Up/Down (and J/K) move only in the active scope, while the shell's
  single scope switcher uses Left/Right between visible leaf scopes. A local
  control may keep a key by calling `preventDefault`; text inputs are never
  intercepted. Nested parent scopes yield to their visible child scopes, and an
  open dialog's scopes never switch focus into the background workspace.

## Workspace transitions

- Authenticated workspace switches keep `MainLayout` mounted: the sidebar and
  workspace identity are stable chrome, while the content pane shows a scoped
  placeholder until route, runtime, and doc-meta ownership agree. Pending scope
  still fails closed — never retain the previous workspace's rows or `<Outlet />`
  content — and passes `workspaceReady={false}` so workspace-owned background work
  and the mobile workspace stack do not start early. The workspace identity's
  syncing state follows that same scoped readiness, not the coarser connection
  state; an online transport does not imply that workspace data is ready.

## ACP authentication

- Custom and Registry Provider authentication renders supported agent-driven method choices and
  request-scoped URL plus text/secret/single-select form interactions. Form replies use the
  encrypted authentication-input path; deprecated `env_var` and non-interactive terminal methods
  do not become Provider-config credential forms. Authorization pages are HTTP(S) only. Bind every
  progress event and reply to the exact machine/config/launch/env snapshot that started the request;
  changing that target cancels the old request, and a late reply must not clear or report an error
  over a newer interaction. Clear manual codes and form values on completion, cancellation, target
  change, and failure; never seed a secret field from retained progress.
