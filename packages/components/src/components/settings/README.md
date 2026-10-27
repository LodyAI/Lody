# Settings surfaces

Binding guidelines live in [AGENTS.md](AGENTS.md).

## Usage and quota placement

| Surface                | Responsibility                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Agents / Configuration | Machine-bound Provider configuration and compact quota                                                             |
| Agents / Account quota | Provider groups across all visible machines, using shared rows with full quota windows, resets and balance         |
| AI Usage               | Capability-gated workspace consumption, reporting period, activity, Model/Member breakdown, day detail and sharing |

Agents configuration uses machine tabs; account quota groups all visible sources
by Provider, with each row naming its owning machine. Switching back restores the
selected machine. The header icon in `agents-view-toggle.tsx` crossfades with blur;
reduced motion keeps only the fade. View state resets on workspace change.

`MachineProvidersSection` and `AgentsProviderQuotaView` reuse `ProviderRow`, its
configuration/menu/forecast actions and its capability-gated quota refresh.
`provider-quota-windows.tsx` renders full windows in the quota view. Editing a
cross-machine row targets that row's machine. Grouping uses provider identity and
resolved brands; it never merges accounts or sums percentages. Configurations with
no visible owning machine are excluded. Quota history, disclosure panels and
distribution rails are removed.

AI Usage retains consumption only and requires `usageAnalytics`; local Agents
quota never mounts cloud consumption hooks. The mixed Provider/machine attribution
table and full waiting list remain reference-only. See the [decision and review
limits](../../../../../.agents/notes/proposed/feature/2026-10-26-agent-usage-ux-research.md).

## Usage range transitions

`usage-calendar-visualization.tsx` keeps a positioned view frame across hourly and
calendar ranges so exiting charts retain their measured coordinates. The hourly
ring grid changes inside that frame. Whole-view opacity fades handle the handoff;
calendar cells render together without individual reveal animations. The
[transition decision](../../../../../.agents/notes/implemented/bug-fix/2026-10-21-usage-range-transition.md)
records the misplaced-chart reproduction and browser coverage.

## Machine connection marks

`workspace-machine-accordion.tsx` renders the connection mark for collapsed and
expanded machine cards. An online machine keeps its solid green centre while
its halo expands and contracts at a constant speed over 2.8 seconds, using linear
CSS transform and opacity animation. Each direction takes 1.4 seconds.
Offline machines keep a static gray dot. Reduced motion keeps the online halo
static. Motion follows the existing `isOnline` value and adds no presence polling.

The [OnlineStatusMotion story](../../stories/DevicesDesktopLayout.stories.tsx)
uses the real machine card with a controlled online/offline value for inspection.
