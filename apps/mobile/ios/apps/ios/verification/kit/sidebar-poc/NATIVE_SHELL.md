# Native shell + React content POC

Open **Settings → Debug → Native Shell POC** on iPad. This is an offline,
Debug-only experiment; it does not replace the product entry point.

`UISplitViewController` owns two ordinary `UINavigationController`s. UIKit owns
headers, `UISearchController`, push/pop, safe areas and keyboard constraints.
React owns the content, search filtering, counters and drafts. A successful
native pop releases the project content; a cancelled interactive pop retains it.

The shell is presented outside the existing React surface. Each React content
page uses Expo's `layoutRoot` and its own React surface touch handler. Native
size updates go directly to Fabric; no geometry event or frame state enters JS.
The full-screen presentation is the POC entry mechanism, not a proposed second
product navigation manager.

An earlier in-tree reparenting experiment rendered correctly but failed moved
presses: the precompiled Expo framework and the app held separate internal
content-origin registries. That experiment was removed. Do not reintroduce a
second touch handler under an existing React touch root.

Run `pnpm verify:ui --case native-shell --app /absolute/path/to/Lody.app`.
The case leases an iPad and exercises both appearances, genuine React presses
with movement, native search, drafts, cancelled return, completed return,
rotation and dismissal. Actual freeform iPad window resizing and production
session integration remain outside the verified scope. Revalidate Expo's
`layoutRoot` contract before a dependency upgrade or product migration.
