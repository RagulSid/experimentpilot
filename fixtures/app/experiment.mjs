// Test fixture: the constants file of an app under experiment. The guard reads it as text.
export const FLAG_NAME = 'pilot_rehearsal_1';

// Must equal the metric's event name exactly (case-sensitive).
export const CTA_EVENT = 'cta_clicked';

// Shown when Flagsmith is unreachable, slow, or returns an unknown value.
export const FALLBACK_VALUE = 'control';
