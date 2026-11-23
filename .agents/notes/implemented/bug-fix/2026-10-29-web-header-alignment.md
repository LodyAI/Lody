# Align desktop web workspace headers

Status: implemented
Translation: current

[中文](2026-10-29-web-header-alignment.zh.md)

## Abstract

Desktop web's sidebar and workspace headers had different vertical origins: the workspace card starts 4px below the sidebar. Web now uses the existing macOS row geometry so both headers share the y=23 centerline. Native mobile shells and Electron's platform-specific titlebar behavior retain their existing rules. Browser visual verification remains necessary.

The sidebar uses 2px top padding; unbordered and bordered workspace rows use 6px and 5px bottom padding respectively. This extends the geometry in the [thin workspace frame decision](2026-10-23-thin-workspace-frame.md) to desktop web without changing the frame or native window controls.
