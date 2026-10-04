// Automations: a message that is sent in a fresh thread of a repository at set times.
import type { Automation, Schedule } from '@acocrew/shared';

// How often the server looks for automations that are due.
export const CHECK_MS = 60_000;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// A time and days as they are kept, or null if they cannot be used.
export function readSchedule({ time, days }: Partial<Schedule>): Schedule | null {
  const usable =
    typeof time === 'string' &&
    TIME.test(time) &&
    Array.isArray(days) &&
    days.length > 0 &&
    days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return usable ? { time, days: [...new Set(days)].sort() } : null;
}

// The first moment after `after` that the schedule names, on this machine's clock.
export function nextRun({ time, days }: Schedule, after: number) {
  const [hours, minutes] = time.split(':').map(Number);
  // Today's moment may be over, so the same weekday a week on is looked at too.
  for (let ahead = 0; ahead <= 7; ahead++) {
    const at = new Date(after);
    at.setDate(at.getDate() + ahead);
    at.setHours(hours, minutes, 0, 0);
    // JavaScript counts days from Sunday. We count from Monday.
    if (at.getTime() > after && days.includes((at.getDay() + 6) % 7)) return at.getTime();
  }
  throw new Error('A schedule needs a day.');
}

// An automation as it is stored.
export type Stored = Omit<Automation, 'nextAt'>;

// A stored automation as the web app sees it: with the moment it runs next.
export const shown = (row: Stored): Automation => ({ ...row, nextAt: row.on ? nextRun(row, Date.now()) : null });
