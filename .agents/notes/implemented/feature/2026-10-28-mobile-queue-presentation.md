# Mobile queue presentation

Status: implemented
Translation: current

[中文](2026-10-28-mobile-queue-presentation.zh.md)

## Abstract

The mobile conversation used the older queue layout although a roomier one-line queue had been prototyped for scheduled messages. The conversation now uses that layout on phones, with row actions in a More menu. Steer remains available under the same capability and queue-position rules. Desktop keeps its existing layout; scheduled reservations are not connected by this change.

The menu also retains move to top, edit and delete. The queue editing suite passes 14 cases, including selecting Steer in the mobile menu and observing the item delivered to its handler. Component typecheck, formatting and documentation checks pass. The full-page phone Storybook and open menu were inspected with synthetic data; physical-device behavior remains unverified.
