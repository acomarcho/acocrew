import { expect, test } from 'vite-plus/test';
import { nextRun, readSchedule } from './automations.ts';

// Moments on this machine's clock. 5 October 2026 is a Monday.
const at = (day: number, time: string) => new Date(`2026-10-${String(day).padStart(2, '0')}T${time}:00`).getTime();
const next = (time: string, days: number[], after: number) => nextRun({ time, days }, after);

test('the next run is the first moment after now that the schedule names', () => {
  const weekdays = [0, 1, 2, 3, 4];
  // Later today, then tomorrow once today's moment has come.
  expect(next('09:00', weekdays, at(5, '08:59'))).toBe(at(5, '09:00'));
  expect(next('09:00', weekdays, at(5, '09:00'))).toBe(at(6, '09:00'));
  // Friday evening: over the weekend to Monday.
  expect(next('09:00', weekdays, at(9, '18:00'))).toBe(at(12, '09:00'));
  // Only Sundays, asked on a Sunday after the time: a whole week on.
  expect(next('07:30', [6], at(11, '07:31'))).toBe(at(18, '07:30'));
  expect(next('00:00', [5, 6], at(5, '12:00'))).toBe(at(10, '00:00'));
});

test('a schedule needs a 24 hour time and at least one day of the week, each day once', () => {
  expect(readSchedule({ time: '23:59', days: [4, 0, 4] })).toEqual({ time: '23:59', days: [0, 4] });
  for (const time of ['9:00', '24:00', '09:60', '', undefined]) expect(readSchedule({ time, days: [0] })).toBeNull();
  for (const days of [[], [7], [-1], [1.5], ['1'], undefined])
    expect(readSchedule({ time: '09:00', days } as never)).toBeNull();
});
