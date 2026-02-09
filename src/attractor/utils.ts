/**
 * Shared utility functions for the Attractor engine.
 */

// ---------------------------------------------------------------------------
// Duration Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a duration string like "900s", "15m", "2h", "250ms", "1d"
 * into milliseconds.
 */
export function parseDuration(duration: string): number {
  const match = duration.match(/^(-?\d+)(ms|s|m|h|d)$/);
  if (!match) {
    // Try as plain number (ms)
    const num = parseInt(duration, 10);
    if (!isNaN(num)) return num;
    return 0;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'ms': return value;
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return value;
  }
}
