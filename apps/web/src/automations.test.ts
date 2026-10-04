import { expect, test } from 'vite-plus/test';
import { describe, inYourTime, zoneName } from './automations';

const WEEKDAYS = [0, 1, 2, 3, 4];
const HOUR = 60;
// A time the way this machine writes it, so the tests do not hang on its language.
const clock = (hours: number, minutes = 0) =>
  new Date(2000, 0, 1, hours, minutes).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

test('a clock is named by how far it is ahead of UTC', () => {
  expect(zoneName(0)).toBe('UTC');
  expect(zoneName(7 * HOUR)).toBe('UTC+7');
  expect(zoneName(-8 * HOUR)).toBe('UTC-8');
  // India and Newfoundland are half an hour off.
  expect(zoneName(5.5 * HOUR)).toBe('UTC+5:30');
  expect(zoneName(-3.5 * HOUR)).toBe('UTC-3:30');
});

test('a schedule says which clock it is on', () => {
  expect(describe({ time: '09:00', days: WEEKDAYS }, 0)).toBe(`Weekdays at ${clock(9)} UTC`);
  expect(describe({ time: '07:30', days: [5, 6] }, 7 * HOUR)).toBe(`Weekends at ${clock(7, 30)} UTC+7`);
  expect(describe({ time: '09:00', days: [] }, 0)).toBe(`No day picked at ${clock(9)} UTC`);
});

test('a reader on another clock is told the time on theirs', () => {
  // The case that was reported: the server is on UTC, the person seven hours ahead.
  expect(inYourTime({ time: '09:00', days: WEEKDAYS }, 0, 7 * HOUR)).toBe(` (${clock(16)} your time)`);
  // The other way around, and half an hour off.
  expect(inYourTime({ time: '09:00', days: WEEKDAYS }, 7 * HOUR, 0)).toBe(` (${clock(2)} your time)`);
  expect(inYourTime({ time: '09:00', days: WEEKDAYS }, 0, 5.5 * HOUR)).toBe(` (${clock(14, 30)} your time)`);
  // The same clock needs no second time, wherever it is.
  expect(inYourTime({ time: '09:00', days: WEEKDAYS }, 0, 0)).toBe('');
  expect(inYourTime({ time: '09:00', days: WEEKDAYS }, 7 * HOUR, 7 * HOUR)).toBe('');
});

test('past midnight the days move along with the time', () => {
  // Monday evening on the server is Tuesday morning seven hours ahead.
  expect(inYourTime({ time: '20:00', days: WEEKDAYS }, 0, 7 * HOUR)).toBe(
    ` (Tue, Wed, Thu, Fri, Sat at ${clock(3)} your time)`,
  );
  // Monday morning on the server is Sunday evening eight hours behind. Sunday wraps around to the end.
  expect(inYourTime({ time: '03:00', days: [0] }, 0, -8 * HOUR)).toBe(` (Sun at ${clock(19)} your time)`);
  expect(inYourTime({ time: '03:00', days: [5, 6] }, 0, -8 * HOUR)).toBe(` (Fri, Sat at ${clock(19)} your time)`);
  // Every day stays every day, so only the time is said.
  expect(inYourTime({ time: '20:00', days: [0, 1, 2, 3, 4, 5, 6] }, 0, 7 * HOUR)).toBe(` (${clock(3)} your time)`);
});
