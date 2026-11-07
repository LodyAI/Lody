# Workspace Settings Round 2 Design

Canvas: https://claude.ai/artifact/SRXCRW4yovsSmE9TMALgMd (rows D and E are the target; rows A–C are today).

## Intent

The pages under Settings › Workspace read as walls of rows and long footers. The user named four problems:

1. **Unclear information hierarchy.** Numbers that are shaped like charts are shown as lists. Visualize whenever the data allows. AI Usage should be entirely charts.
2. **Loading indicators fight the HIG components.** On a first load one page shows a pull-to-refresh spinner, a spinning header Refresh button, and "Loading remote settings…" placeholder text all at once. Errors are rendered as a `Retry` content row, which blurs content with status.
3. **Duplicated data hides what a page is for.** Examples: Machine IDs repeated in footers and subtitles, machine names in two headers, a provider name repeated under the agent name, the `/shortcut:` prefix on every row.
4. **Navigation bar items must be SF Symbols, never text labels.** A single right symbol must be a 44 × 44 circle. Today it is an oval.

## Goals

- Every list page in the Workspace section follows one loading, error and refresh model.
- Each piece of information appears once per page.
- Visual forms are used where the data is quantitative.
- Header items are symbol-only, and a single right item is a circle.

## Non-goals

- General (the workspace name and icon sheet), MCP editor behavior, and GitHub page structure. Beyond the shared loading, error and header rules, these keep today's layout.
- Changing data sources, cloud protocol, caching, or which fields the server returns.
- Account, Personal and Conversations & History sections.

## Anti-goals

- A second list component, or RN overlays simulating native effects. Visuals live inside `LodyGroupedList` cells.
- Green as the app accent. A green _status_ dot for "online" uses `systemGreen` and is always paired with text. This is my call; flag it if unwanted.
- Inventing data the server does not send, such as a "last seen" time or deltas versus the previous period.
- Color as the only carrier of meaning.

## Shared rules (all affected pages)

### Loading / refresh / error

| State                                             | Shows                                                                                                                                                                                                      | Never shows                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| First load, no cached data                        | Skeleton rows in grouped cells: 3 rows, an icon block and two bars. `aria-busy` is exposed to VoiceOver as "Loading".                                                                                      | Placeholder text, refresh-control spinner, header spinner |
| Has data (cached or live), refreshing             | Content stays; the refresh control spins only when the user pulled                                                                                                                                         | Header refresh button                                     |
| Load failed, nothing cached                       | Full-page `UIContentUnavailableConfiguration`: a symbol, a title ("Couldn't Load Machines" etc.), a one-line message, and a prominent **Try Again** button                                                 | A Retry row                                               |
| Refresh failed, data cached                       | Content stays, with a notice strip at the top of the list: a warning symbol, a short text such as "Offline · showing data from 2 h ago" (uses the existing `syncedAt`), and a circular retry symbol button | A Retry row, error footer paragraphs                      |
| Partial data (AI Usage `errors`, GitHub `errors`) | The notice strip with the existing meaning ("Some sources unavailable")                                                                                                                                    | A Retry row                                               |

- Remove the header Refresh `NativeSymbolButton` from RemoteSettings (machine, agent, MCP), GitHub, AI Usage and Project Visibility.
- Pull-to-refresh stays on every page.
- Write paths keep their current guards: busy flags, version counters, no automatic replays. On Projects and GitHub, a busy write keeps disabling the pop-up rows, as today.
- _(builder's call)_ A failed write on Projects or GitHub keeps today's lock: the pop-ups stay disabled until a re-read succeeds. The notice strip reads "Couldn't confirm the change · refresh to check". Its button only re-reads and never re-sends the write.
- _(builder's call)_ Pages without `syncedAt` remember their last successful load time in memory for the notice text. A failed refresh keeps the rows already shown and does not clear them.
- _(builder's call)_ When the catalog is disconnected (`connected=false`) but the settings fetch succeeded, the notice strip shows "Offline · status unavailable" and status dots show unknown.

### Navigation bar

- Editors (`RemoteSettingEditorScreen`, `PromptShortcutEditorScreen`) use `xmark` on the left and a prominent `checkmark` on the right, both with `accessibilityLabel`. This matches `WorkspaceEditorScreen`. When a save failed, the shortcut editor's right button stays `checkmark`, and its label changes to "Retry".
- `PromptShortcutsScreen`: replace `title` + `systemImage` (react-native-screens silently ignores `systemImage`, so it renders as the text "Add Shortcut") with `icon: { type: 'sfSymbol', name: 'plus' }` and `accessibilityLabel`. Drop the unused `NativeSymbolButton` import.
- Rule: bar items are image-only items (`icon: { type: 'sfSymbol' }`). A custom RN view in the header is a last resort and must be framed at 36 pt or less. A 44 pt custom view becomes a ~52 × 44 oval because iOS 26 pads `customView` items inside the glass platter. See `RNSScreenStackHeaderSubview.mm:214-249`.

### Copy

- Footers become one line where possible. Delete footer sentences that restate rules the UI already enforces, such as read-only explanations when a lock symbol is shown.
- Update both `locales/en.json` and `locales/zh-Hans.json`. Remove keys that become unused.

## Per page

### AI Usage

Top to bottom:

1. Segmented Day / Week / Month / All time (unchanged).
2. **Stat tiles**: two side-by-side tiles, Tokens and Estimated cost. Values are compact: "1.28M" and "$3.42", with the cost rounded to cents unless it is under $0.01, where it shows "<$0.01". The VoiceOver value is the full number.
3. **Bar chart** (Swift Charts) of `timeline.buckets` tokens, for every bucket the server returns. Today's 30-row cap is a list limit. The x-axis shows UTC time labels sized to the range, plus a recessive grid. Touching or dragging selects a bar. The chart header shows that bucket's time, tokens and cost. With no selection it shows the peak bucket. Hidden when there is no timeline (summary only).
4. **Token mix**: a stacked horizontal bar of the `breakdown` categories, then a legend list with a color square, the label, a tabular value and a percent. The fixed category order and colors, validated for CVD separation, are Input `systemBlue`, Output `systemOrange`, Cache read `systemIndigo`, Cache write `systemTeal`, Reasoning `systemPurple`. Each segment is separated by a 2 pt gap. Hidden when there is no breakdown.
5. One footer line: "Cloud estimates, not a bill · Updated HH:MM UTC".

The UTC timestamp row list and its footers are removed. Missing values show "—", never zero. The "Unavailable" semantics are kept.

### Agents (RemoteSettings kind `agent`)

- One section per machine. Its header is the machine name with a status dot and text ("MacBook Pro · Online"). The second "· Subscription usage" section is removed.
- When eligible usage exists, a **rings** cell sits at the top of that machine's section. It holds up to 3 rings per row, wrapping if there are more. Each ring shows its percent in the center, a label (`{provider} · {5h|7d}`) and a caption ("Resets 14:00", "Resets Oct 21", "Reset unknown"). The data comes from `agentUsageRows`, unchanged.
- Configuration rows show only the name. The provider subtitle is dropped when it repeats the name or provider. Agent icons use the existing `agentIcon(...)` assets, as ProjectHistory does. Read-only rows show a trailing `lock` symbol with the label "Owner only".
- Ring labels keep the quota name and window label from `agentUsageRows`, so two quotas for one provider stay distinct.
- The footer is one line: "Quotas are this machine's subscriptions, not workspace billing." Machine ID footers are removed.
- _(builder's call)_ An offline or unknown-status machine still shows its cached rings, drawn in secondary tint. Its footer becomes "Last reported quota · machine offline", or "· status unavailable". "No quota reported while offline." is used only when nothing is cached.

### Machines (RemoteSettings kind `machine`)

- Rows: the device symbol with a status badge dot (online `systemGreen`, offline `systemGray`, unknown `systemGray3`), the title, and a subtitle of "{Online|Offline|Status unavailable} · {detail}". The machine ID is removed from the row.
- Read-only machines keep the status subtitle and add a trailing `lock` symbol. The old "Only the machine owner can edit" line is removed.
- The footer is one line: "Names are shared across this workspace. You can rename machines you own."
- The editor footer shows the machine ID in monospace with a copy button (44 pt hit area). Copying uses the clipboard API already in the project, if there is one. If not, the builder picks the RN-safe option and says so.

### MCP servers

Only the shared rules apply: loading, error, header and editor header. The layout is otherwise unchanged.

### Projects

- A short top description: "Choose who in this workspace can see each project."
- Section headers: the machine name with a status dot. The raw machine ID footers are removed.
- Rows: a `folder` symbol, the name, and a path subtitle (monospace, truncating in the middle).
- Owned rows: a pop-up whose value shows a symbol and a label (`person.2` Shared / `lock` Private), using the existing `options`.
- Others' rows: the same symbol and label in secondary color, not interactive, with the subtitle "Owned by another member".
- Unknown state: `questionmark.circle` with "Unknown".
- Bottom footer: "Doesn't delete files or history."

### Prompt Shortcuts

- The subtitle is the slug only, in monospace (`/review-pr`). The ready/limited sentences are removed.
- _(builder's call)_ Any row the editor would open read-only shows a trailing `eye` symbol with the label "View only". That covers a non-simple template, another member's shortcut, and a prompt over 16,000 characters. The row builder takes ownership from the index entry.
- The footer is one line: "In chat, type /shortcut: and pick one."

### GitHub

Only the shared rules apply. Today's `Retry` error section becomes the notice strip or the unavailable page.

## Native work (LodyKit)

`LodyGroupedList.swift` is already about 1,228 lines. Put new behavior in new files under `modules/lody-kit/ios/List/` and keep the main file's growth to wiring. Additions to the TS types in `modules/lody-kit/src/list/`:

- `NativeGroupedListProps.loading?: boolean`: skeleton while there are no rows. This replaces using `placeholder` for loading.
- `NativeGroupedListProps.unavailable?: { symbol: string; title: string; message?: string; actionTitle?: string }` plus `onUnavailableAction`, using `UIContentUnavailableConfiguration`.
- `NativeGroupedListProps.notice?: { symbol: string; text: string; tint?: string; actionSymbol?: string; actionLabel?: string }` plus `onNoticeAction`, as a list header strip that scrolls with content.
- `NativeListRow.status?: 'online' | 'offline' | 'unknown'`: a badge dot on the leading image.
- `NativeListRow.trailingSymbol?: string` plus `trailingSymbolLabel?: string`: a non-interactive trailing glyph.
- `NativeListRow.valueSymbol?: string`: a symbol shown before `value`, for pop-up rows too.
- `NativeListSection.headerStatus?: 'online' | 'offline' | 'unknown'`: a dot before the header text.
- `NativeListSection.visual?`: one cell at the top of the section, rendered with `UIHostingConfiguration` (SwiftUI + Swift Charts). Variants:
  - `{ type: 'stats', items: { label; value; accessibilityValue }[] }`
  - `{ type: 'bars', items: { id; label; value; detail; accessibilityLabel }[]; axisLabels: string[] }`
  - `{ type: 'mix', items: { label; value; percent; accessibilityValue }[] }`
  - `{ type: 'rings', items: { label; caption; fraction; accessibilityLabel }[] }`

  Selection on `bars` is local to native; it sends no RN event. Colors come from the fixed mix order above, never cycled. Dark mode uses the system colors' dark variants.

Run `pnpm --filter @lody-ios/mobile pods` after adding Swift files.

## Verification

- Update the existing cases in `apps/mobile/verification/ui`: `ai-usage.py`, `machine-settings.py`, `mcp-settings.py`, `github-settings.py`, `project-visibility.py`, `prompt-shortcuts.py`, `settings.py` and `settings-baseline.py` if they assert removed rows, text or the header refresh.
- Add Debug fixture states for skeleton, unavailable and notice to the existing preview scenes (`src/screens/debug/*PreviewScreen.tsx`), injected at the service boundary. Each state needs a case that captures light and dark screenshots. The bar selection needs a check, made by touching a bar and reading the chart header's `accessibilityValue`. Also check that a single right header item is circular, by measuring the platter frame.
- Update unit tests in `apps/mobile/tests/settings/` for changed section builders.
- Run `pnpm check`, `pnpm test`, `pnpm bundle`, and a simulator build via `pnpm verify:build`. Keep normal signing.

## Constraints

- Other sessions commit to `main` concurrently. `LodyGroupedList.swift` already has another session's uncommitted edit in `rowSwitchChanged`. Preserve it, and stage only this work's files.
- No nested ternaries. No comments or JSDoc unless they meet the user's exceptions. Keep files under 500 lines and components under 300 lines.

## Left to the builder

- AI Usage keeps the segmented control visible on its unavailable page.
- Editors disable the `checkmark` while a save is in flight.

- Exact skeleton bar widths, ring diameter (around 72 pt), chart height (around 150 pt), and the notice strip's material.
- Compact number formatting (`Intl` in RN versus formatting in Swift). Pick one and use it consistently.
- How the rings cell wraps more than 3 items.
- Whether `bars` axis labels are computed in TS or Swift.
