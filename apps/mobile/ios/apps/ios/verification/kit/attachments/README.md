# Attachment transport check

From the repository root (automatically leases a Lody Verify Simulator):

```sh
pnpm verify:native --case attachments
```

Runs the production uploader against URLProtocol responses with synthetic auth.
Checks image multipart encoding, file hashing, the 16 MiB part boundary, failed
part cleanup, and rejection of files outside picker storage. `pnpm test` checks
that attachment references reach both persisted history and Machine RPC and
survive a lost append acknowledgement. These checks do not send a live cloud turn.

Cloud limits: eight images (5 MiB each after conversion) and eight files
(100 MiB each) per message. HEIC and oversized photos convert to JPEG at up to
2048 pixels. Videos and other non-image types upload as files; a movie marked
as an image is coerced onto the file route instead of extracting a still.
Upload failure retains the draft; no message dispatch is retried
automatically. History displays image thumbnails above their text bubbles; files retain their names.

Settings → Diagnostics → Export diagnostic file includes upload request start,
success and failure events for images, files and multipart create/part/complete/abort.
A random per-attachment attempt ID joins multipart requests without recording any
workspace, session, filename, URL, attachment content or credentials. Failures
include HTTP status, allowlisted server error categories (including authorization
and storage quota), or native URL loading error codes. Unknown server error text
and codes are omitted. Invalid JSON and incomplete upload responses are recorded
separately. The native check exports the real on-disk diagnostics and verifies
failure stages, multipart cleanup correlation and private-data exclusion.

Attachment routes are hosted on `https://api.lody.ai`, separately from the
`backend.lody.ai` auth/Streams token service. An unauthenticated POST to
`/api/workspaces/test/session-images/upload`, `session-files/upload`, and
`session-files/multipart/create` on that host returns 401; an unknown route
returns 404. Verify this routing against the live host when changing endpoints;
URLProtocol checks alone cannot establish deployment routing.
