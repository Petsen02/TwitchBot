/**
 * Timezone-aware day boundaries.
 *
 * "Today" for !gains has to mean the streamer's local day, not UTC, or the
 * counter resets at 01:00 or 02:00 depending on daylight saving.
 */

function offsetMsFor(timezone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .filter((part) => part.type !== 'literal');

  const field = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));

  const asUtc = Date.UTC(
    field.year,
    field.month - 1,
    field.day,
    field.hour % 24,
    field.minute,
    field.second,
  );

  return asUtc - date.getTime();
}

/** Epoch milliseconds of the most recent local midnight in `timezone`. */
export function startOfDay(timezone, now = new Date()) {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);

  // Guess the UTC instant for local midnight, then correct by the offset that
  // actually applies at that instant. This stays right across DST changes.
  const guess = Date.UTC(year, month - 1, day);
  return guess - offsetMsFor(timezone, new Date(guess));
}

/** Local calendar date as YYYY-MM-DD, used as the key for a day's baseline. */
export function localDateKey(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Wall-clock time in the configured timezone, as HH:MM. */
export function formatClock(timestamp, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

/** Calendar date in the configured timezone, as d/m/yy. */
export function formatDate(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'numeric',
    year: '2-digit',
  })
    .formatToParts(new Date(timestamp))
    .filter((part) => part.type !== 'literal');

  const field = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  // en-GB pads day and month even when asked for "numeric", so strip it here.
  return `${Number(field.day)}/${Number(field.month)}/${field.year}`;
}

/** Formats a match duration in seconds as m:ss, matching the reference bot. */
export function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
