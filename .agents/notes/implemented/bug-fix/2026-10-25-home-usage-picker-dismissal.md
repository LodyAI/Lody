# Close the home usage Provider picker after selection

Status: implemented
Translation: current

PR: [#1882](https://github.com/LodyAI/Lody/pull/1882)

[中文](2026-10-25-home-usage-picker-dismissal.zh.md)

## Abstract

The home dashboard's plan-usage Provider picker stayed open after a selection.
Its radio items inherited Base UI's default of keeping the menu open. Each item
now explicitly sets `closeOnClick`, so choosing another Provider or choosing the
current one dismisses the picker. The fix is local to this picker and preserves
the shared menu primitive's defaults.

## Decision and evidence

[`UsageSourcePicker`](../../../../packages/components/src/components/chat/home/tiles.tsx)
uses `Menu.RadioGroup` for selection and `Menu.RadioItem` for each Provider.
The [Base UI contract](https://base-ui.com/react/components/menu#radio-item)
defaults `closeOnClick` to `false`. Each item owns dismissal through this prop,
without adding controlled menu state or coupling closing to the selection callback.
This supplements the [home dashboard decision](../feature/2026-10-16-home-week-tiles.md).

## Verification and limits

The existing [dashboard component suite](../../../../packages/components/tests/home-dashboard-component.test.tsx)
now opens the real menu and checks that both an unchanged selection and a changed
selection close it and report the activated Provider id. Base UI also invokes
the selection callback when activating the current value; the initial assertion
that this activation emitted nothing was incorrect, as demonstrated by CI.
The targeted dashboard and week suites could not start because the available
dependency tree lacks `@stylexjs/unplugin`. Browser behavior remains unverified.
