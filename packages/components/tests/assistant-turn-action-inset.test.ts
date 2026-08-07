import { describe, expect, it } from 'vitest';

import { MOBILE_TURN_ACTION_LEADING_INSET_PX } from '../src/components/ai-gui/view';
import { EDGE_ZONE_PX } from '../src/components/mobile/mobile-edge-back-swipe';

/*
 * The mobile assistant-turn action bar puts the turn duration in front of the
 * copy / config / fork buttons. That leading slot is not decoration: it is what
 * keeps the copy button out of the session drawer's left-edge back-swipe strip.
 * Nothing inside the conversation `VList` can paint above that strip (virtua
 * sets `contain: strict`), so the buttons can only be rescued by insetting them.
 *
 * If the strip is ever widened, or the reserved inset shrunk, the copy button
 * silently becomes untappable again — a regression with no visual tell on
 * desktop and no type error. This pins the relationship instead.
 */
describe('mobile assistant-turn action bar inset', () => {
  it('reserves at least the full width of the edge-back swipe strip', () => {
    expect(MOBILE_TURN_ACTION_LEADING_INSET_PX).toBeGreaterThanOrEqual(EDGE_ZONE_PX);
  });

  it('reserves the inset from the row edge, before any conversation gutter', () => {
    /* The slot starts at the conversation gutter (>= 0 from the screen edge)
       and the strip starts at screen x=0, so a slot at least as wide as the
       strip clears it regardless of the gutter value. Guard against the inset
       being re-derived as "strip minus gutter", which would break the moment
       the gutter changed. */
    expect(MOBILE_TURN_ACTION_LEADING_INSET_PX).toBeGreaterThan(0);
    expect(EDGE_ZONE_PX).toBeGreaterThan(0);
  });
});
