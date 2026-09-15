# Optional annotation in managed previews

Status: implemented
Translation: current

[中文](2026-09-15-preview-optional-annotation.zh.md)

## Abstract

Managed previews reported a generic runtime error three seconds after iframe load,
including when the frame contained a proxy error page. Runtime initialization also
mistook a previous document's referrer for the parent origin and could reject the
real parent's handshake after navigation. The runtime now binds control to its
actual parent, while page loading and proxy readiness are independent of optional
annotation. This preserves browsing without promising annotation on every page.

## Decision and evidence

Keep source-window validation and the first-origin lock; removing origin checks
altogether is unnecessary. Missing annotation leaves the control disabled and
accepts late handshakes, instead of extending the old three-second timeout.
The loading indicator no longer covers the page. The existing parent-driven
reload remains available without an injected receiver.

Adversarial review found that pre-load redirects could be cancelled before the new
origin binding existed. A data-free ready signal now requests an early handshake;
the latest pending navigation waits for parent binding instead of bypassing policy.

Forwarded responses carry a proxy marker independent of the legacy runtime marker.
The latter remains accepted for compatibility. Injection size overhead falls back
to original bytes and preserves CSP without falsely claiming runtime injection.

Targeted tests cover navigation referrers, unrelated senders, origin locking,
late/absent runtime messages, reload, size limits, and proxy readiness. They use
synthetic DOM events and local HTTP fixtures; they do not establish a production
deployment or every browser's CSP behavior. Intent is recorded in the
[draft Spec](../../../../specs/preview-annotation-availability.md).
