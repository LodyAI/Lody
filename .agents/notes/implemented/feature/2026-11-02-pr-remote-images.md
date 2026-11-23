# PR remote images

Status: implemented
Translation: current

[中文](2026-11-02-pr-remote-images.zh.md)

## Abstract

PR descriptions and reviews may include HTTPS images that the desktop renderer's
image policy blocks. A device-local preference defaults automatic loading off;
each image may also be loaded explicitly. An isolated sandboxed document permits
HTTPS images without broadening the main renderer's policy. Image hosts receive
the user's network request; private attachments can still require authentication.

## Decision

Allowing HTTPS directly in the main renderer would also affect other image
surfaces. A sandboxed image-only document is mounted only after explicit consent,
or when automatic loading is enabled, and receives its URL in the fragment. It
has its own restrictive policy, sends no referrer, and accepts HTTPS URLs only.
The setting and one-image consent do not grant credentials to a private host.
Anonymous shared content retains its existing no-network-image boundary.
