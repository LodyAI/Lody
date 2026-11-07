# Duo and iPad native layout

Approved in this chat against the [experience artboard](https://ryugi.innei.dev/a/SQURPD_WxTMTBM5b5Uci).
This supersedes the fold alignment rule in the older wide-layout proposal.

## Behavior

- Duo has three postures: closed, book (partially open), and fully open.
- Closed keeps the native compact navigation stack and one New Session action.
- Book uses the system arrangement to place two panes around the active vertical fold.
- Fully open treats the display as continuous. The sidebar uses its normal reading
  width; an open file sits beside the conversation without pinning the boundary to
  the hardware center. The change from book animates between the old and new pane
  positions, respecting Reduce Motion.
- iPad uses the same space-based rules without a simulated fold. Landscape has a
  sidebar and chat, or chat and detail. Portrait hides the list over the chat and
  opens detail in a sheet. Compact windows retain native back navigation.
- Selecting another session closes its previous detail. Closing detail restores
  the list. Layout changes preserve the session controller, composer draft,
  detail navigation stack and any open transient sheet.
- New-session creation, search, sending and service ownership reuse the existing
  production controllers. The mockup's local replies are not an implementation.
- Activity always opens in a native Sheet, including on wide Duo and iPad layouts;
  it never takes the file inspector column.
- Tool-call details and message details also use Sheets. Subagent-task details
  and PR details use SplitView alongside files and diffs. Compact windows keep
  their native navigation behavior.
- Preserve native safe areas, bars, scroll edges, selection, VoiceOver and touch
  targets. Do not add a second presentation manager or angle-driven animation.

## Verification

Use behavioral native checks and the existing offline iPad/Home UI cases. Cover
compact/regular transitions, detail navigation and sheet persistence, plus real
Duo closed/book/fully-open captures. Build with signing enabled. Run pnpm check,
pnpm test, pnpm bundle and a signed Simulator build. Report hardware/input-driver
limits separately from product failures.
