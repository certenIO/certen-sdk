import { parseDuration } from '@certen.io/sdk';
import { UsageError } from './errors.js';

/**
 * A length of time on a command line: `90s`, `6m`, `1h`, `2d`, or a bare number.
 *
 * `--timeout 6` meant six minutes and nothing on the command line said so. A bare number keeps the meaning it has always had
 * (minutes for a timeout, seconds for a poll interval), so no working script changes; a unit says what it means.
 *
 * The unit form is the SDK's `parseDuration`, the same rule `--expires-in` follows: one positive whole number and one unit
 * (`s`, `m`, `h`, `d`). Nothing else is guessed at. A bare number may carry a decimal, as it always could (`--timeout 0.5`);
 * hex and exponent spellings were never documented and are refused rather than read as something surprising.
 *
 * Raised as a usage error before any request, passphrase prompt or Idempotency-Key: a typo in a wait flag must not be discovered
 * after an identity or an intent exists.
 */
export function parseSpanMs(
  text: string,
  bare: 'minutes' | 'seconds',
  flag: string,
  code: string,
): number {
  const trimmed = String(text ?? '').trim();

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n) && n > 0) return n * (bare === 'minutes' ? 60_000 : 1_000);
  } else if (/^\d+\s*[smhd]$/i.test(trimmed)) {
    try {
      return parseDuration(trimmed);
    } catch {
      // fall through to the one message below: a unit form the SDK refuses (zero) is the same mistake as any other
    }
  }

  throw new UsageError(
    `${flag} must be a positive number of ${bare}, or a duration such as 90s, 6m or 1h (units s, m, h, d). Got "${text}".`,
    code,
  );
}
