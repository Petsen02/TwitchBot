/**
 * Timezone-aware day boundaries.
 *
 * "Today" for !gains has to mean the streamer's local day, not UTC, or the
 * counter resets at 01:00 or 02:00 depending on daylight saving.
 *
 * The day need not start at midnight. A tally of today's games is for the
 * person playing them, and they are often still playing at midnight -- the
 * count resetting mid-session is worse than a "day" that runs to the small
 * hours. `startHour` moves the boundary to a time nobody is online.
 */

/**
 * The calendar date of the tracking day `date` falls in.
 *
 * Decided by comparing the local wall clock to the boundary, not by moving
 * the instant back. On the spring-forward day an hour does not exist, so
 * "six hours earlier" and "six hours earlier on the clock" are different
 * times, and only the clock is what anyone means by when the day starts.
 */
function trackingDate(timezone, date, startHour) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  })
    .formatToParts(date)
    .filter((part) => part.type !== 'literal');

  const field = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));

  // Some locales render midnight as hour 24.
  if (field.hour % 24 >= startHour) {
    return { year: field.year, month: field.month, day: field.day };
  }

  // Before the boundary the day before is still running. Stepping back over
  // month and year ends is left to Date, as plain calendar arithmetic.
  const previous = new Date(Date.UTC(field.year, field.month - 1, field.day - 1));

  return {
    year: previous.getUTCFullYear(),
    month: previous.getUTCMonth() + 1,
    day: previous.getUTCDate(),
  };
}

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

/** Epoch milliseconds of the most recent local day start in `timezone`. */
export function startOfDay(timezone, now = new Date(), startHour = 0) {
  const { year, month, day } = trackingDate(timezone, now, startHour);

  // Guess the UTC instant for the local boundary, then correct by the offset
  // that actually applies at that instant. This stays right across DST
  // changes.
  const guess = Date.UTC(year, month - 1, day, startHour);
  return guess - offsetMsFor(timezone, new Date(guess));
}

/**
 * The tracking day as YYYY-MM-DD, used as the key for a day's baseline.
 *
 * Before the day's start hour this is still yesterday's date, which is the
 * point: the games played at 03:00 belong to the session that began the
 * evening before.
 */
export function localDateKey(timezone, now = new Date(), startHour = 0) {
  const { year, month, day } = trackingDate(timezone, now, startHour);
  const pad = (value) => String(value).padStart(2, '0');

  return `${year}-${pad(month)}-${pad(day)}`;
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
  return `${field.day}/${field.month}/${field.year}`;
}

/** Formats a match duration in seconds as m:ss, matching the reference bot. */
export function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
