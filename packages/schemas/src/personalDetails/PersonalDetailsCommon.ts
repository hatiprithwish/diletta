// DEV_NOTE: Text that is personal whatever surrounds it: an email, a run of six or more digits. Shared by what strips
// chat text for storage (doc gaps, M5-6; an issue's test, M5-7).
export const PERSONAL_EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
export const PERSONAL_LONG_NUMBER_PATTERN = /\d(?:[\s().-]*\d){5,}/;

export function hasPersonalDetailPattern(text: string): boolean {
  return PERSONAL_EMAIL_PATTERN.test(text) || PERSONAL_LONG_NUMBER_PATTERN.test(text);
}
