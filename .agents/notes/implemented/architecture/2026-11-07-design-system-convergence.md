# Product design-system convergence

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875)

[中文](2026-11-07-design-system-convergence.zh.md)

## Abstract

The Tailwind migration preserved effective styles, including legacy opacity and surface overrides that did not follow the product design system. This follow-up adopts the existing control, field, popup and card rules in their real owners rather than preserving those overrides. Disabled opacity has one default owner, while a new media contrast pair covers a previously unnamed image-overlay role. Appearance changes are intentional design-system changes; they remain visible in Before/After reports and do not turn historical migration differences into passes.

## Ownership

| Concern                   | Owner and contract                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disabled control          | `control.disabledOpacity`, default 45%. Button and popup read it directly; field, disclosure and toggle keep their public family aliases. Dim once, including decorated input text, rather than multiplying parent, glyph and control opacity.                                                                                            |
| Field                     | One well and one focus edge. A bare input inherits a parent-owned surface; values, placeholders and icons use their existing family roles. Controls use the 13/18 type step, while message prose follows the body step and conversation-font preference.                                                                                  |
| Composer / message editor | Card material, no perimeter border. The owner draws the focus/drop ring; the bare input explicitly draws none, including against the shell's global focus styles.                                                                                                                                                                         |
| Popup / command           | The containing Dialog or Popover owns its rung. Search uses a well; rows and metadata read popup roles without a second surface or independently chosen alpha.                                                                                                                                                                            |
| Image overlay             | The independent `media.scrim` / `media.label` pair: black 60% under white text. It is theme-independent and restricted to noninteractive captions, progress labels and scrims over external images. On a white image its contrast is about 5.74:1. Ordinary controls keep their component material.                                       |
| Mention cover             | An opaque backdrop plus the well's translucent fill as a second native background layer. This reproduces the actual well without compositing a second translucent cover over the native glyph. Card owners reset the overlay; the shortcut form publishes its actual dialog backdrop. No approximate 5% mix or per-alpha token is needed. |

The browser toolbar's URL and intrinsic-width connection status share Input's one well and focus owner through its trailing slot; refs, native events and input style callbacks stay on the real input. Annotation mode uses the pressed Toggle material with an accent mark. Draft, thread and peek chrome use popup roles and standard controls; editable text keeps the field well. Author hues and shared review-marker colors identify domain data. Pin placement, viewport clamping, anchor resolution, submission and URL restoration remain unchanged.

Context choices use the existing Tabs track and indicator. An unavailable context's help or connection entry remains a working ghost Button, not a falsely dimmed disabled tab; it preserves the original tooltip/connection and controlled-selection behavior. Truly disabled history rows use the shared 45% role. The retained `tone` prop does not create a second local palette over the actual theme owner.

Family aliases resolve where they are declared. The shared disabled default does not promise that an arbitrary subtree override of `control` rebinds every family; existing family theme APIs remain available. The product palette is published on the document root, and forced palettes must use the existing theme owners that redeclare dependent family tokens.

The scope includes shared UI primitives, legacy Sidebar/Command/Emoji/mention owners, Composer and its real rich-input callers, PR merge controls, and audited native disabled controls. It preserves refs, handlers, keyboard and IME behavior, selection, response-driven state and responsive layout. Replacing decorative borders with material, standard control type, and standard grouped-button seams can change geometry; those changes are recorded instead of padded away.

## Verification and limits

Real immutable Storybook builds record their input hashes. The strict browser gate fixes its environment, captures independent repeats, checks actual component state and retains every nonzero raw difference. A separate After contract profile compares real product nodes with public token references in the same palette, including effective opacity through ancestors, field typography, material, placeholder ink, media contrast roles, chip background layers and a single focus edge. A contract pass is not a claim of pixel equality with the old design.

The gate owns its BrowserServer process, connected client and static server. Shutdown disconnects the client, awaits owner close, confirms native exit and verifies that the owned listener refuses connections. Native exit alone was insufficient: retained stdio could delay Playwright's close callback, so only the exited child's own streams are released. Listener probes use a bounded 250ms interval; a rejected tight loop exhausted local ephemeral ports. Deadlines remain failures, only the run's own browser group may be killed, and static-server cleanup proceeds independently. Historical delayed-close, port-exhaustion and rejected visual evidence remain available.

This scoped convergence does not certify every legacy product skin. The AST audit is a read-only inventory of opacity, color mixes, shadows and literal colors with state and owner context. Visibility, motion, artwork, external identity colors and derived design-system materials are not automatically violations. Imported and dynamic expressions remain explicit unresolved entries; the inventory is not a compliance percentage.

The Integrations repository-row fixture remains blocked by the local implicit-workspace bootstrap outside its Context provider. Failed synthetic-port attempts were reverted; no runtime/provider/IPC changes were made to manufacture coverage. Its product style change has source review but no successful repository-row visual qualification. The historical virtualized Quick Open story also remains unqualified; real Command overflow, search, selection and dismissal are exercised separately. Historical migration OPEN/INVALID evidence is retained under its original meaning.

The delivered gate still retains raw-pixel repeat failures: one attachment well corner differs by one RGB step at one pixel, and a light project menu differs by two raw pixels. Geometry and recorded CSS match, but the exact raster cause is not proven. Some old Context and group-menu baselines are also unstable and are not promoted to valid baselines. The self-contained report separates these OPEN results from intentional material changes, successful After contracts and blocked external-avatar scenarios.

Current self-contained reports and machine-readable proofs live in `packages/components/artifacts/visual/`. The [visual harness README](../../../../packages/components/tests/visual/README.md) owns commands; [token rules](../../../../packages/ui/src/tokens/RULES.md) own the design-system policy.
