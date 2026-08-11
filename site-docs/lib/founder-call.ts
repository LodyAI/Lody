/**
 * "Book a call with the founder" booking link, shared by the landing closing
 * CTA, the pricing Enterprise card, and the site footer. `utm_source` marks
 * which entry the booking came from.
 */
export const FOUNDER_CALL_URL = 'https://calendar.notion.so/meet/remch183/hqic3xqu';

export function founderCallUrl(source: 'landing' | 'pricing' | 'footer'): string {
  return `${FOUNDER_CALL_URL}?utm_source=${source}`;
}
