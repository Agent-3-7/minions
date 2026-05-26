import { CronExpressionParser } from 'cron-parser';
import type { ScheduledTask } from '@shared/types';

export type SchedulePreset = 'weekdays' | 'daily' | 'weekly' | 'interval' | 'custom';
export type IntervalUnit = 'm' | 'h' | 'd';

export interface ScheduleFormFields {
  preset: SchedulePreset;
  time: string;
  weekday: string;
  intervalValue: string;
  intervalUnit: IntervalUnit;
  rawSchedule: string;
}

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function nextRun(cron: string): Date | null {
  try {
    return CronExpressionParser.parse(cron).next().toDate();
  } catch {
    return null;
  }
}

export function scheduleSummary(scheduledTask: ScheduledTask): string {
  const raw = (scheduledTask.scheduleDisplay || scheduleRaw(scheduledTask)).trim();
  if (raw) return humanizeSchedule(raw) ?? raw;
  const kind = typeof scheduledTask.schedule?.kind === 'string' ? scheduledTask.schedule.kind : null;
  return kind ?? 'Unscheduled';
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return value === 1 ? singular : plural;
}

function intervalSummary(value: number, unit: IntervalUnit): string {
  const label = unit === 'm' ? 'minute' : unit === 'h' ? 'hour' : 'day';
  return `Every ${value === 1 ? label : `${value} ${pluralize(value, label)}`}`;
}

function formatCronTime(hour: number, minute: number): string {
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function parseCronNumber(value: string, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed >= 0 && parsed <= max ? parsed : null;
}

function dayOrdinal(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  const tens = day % 10;
  if (tens === 1) return `${day}st`;
  if (tens === 2) return `${day}nd`;
  if (tens === 3) return `${day}rd`;
  return `${day}th`;
}

function parseWeekdayList(value: string): number[] | null {
  if (!/^\d+(,\d+)+$/.test(value)) return null;
  const nums = value.split(',').map((part) => Number.parseInt(part, 10));
  if (!nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 7)) return null;
  return Array.from(new Set(nums.map((n) => n % 7))).sort();
}

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function humanizeCron(raw: string): string | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minutePart, hourPart, dayPart, monthPart, weekdayPart] = parts;
  const allWild = dayPart === '*' && monthPart === '*' && weekdayPart === '*';

  const intervalMinutes = minutePart.match(/^\*\/(\d+)$/);
  if (intervalMinutes && hourPart === '*' && allWild) {
    const value = Number.parseInt(intervalMinutes[1], 10);
    return Number.isFinite(value) && value > 0 ? intervalSummary(value, 'm') : null;
  }

  const intervalHours = hourPart.match(/^\*\/(\d+)$/);
  if (intervalHours && allWild) {
    const hours = Number.parseInt(intervalHours[1], 10);
    if (!Number.isFinite(hours) || hours <= 0) return null;
    const minuteNum = parseCronNumber(minutePart, 59);
    if (minuteNum === null) return null;
    if (minuteNum === 0) return intervalSummary(hours, 'h');
    return `Every ${hours === 1 ? 'hour' : `${hours} hours`} at :${String(minuteNum).padStart(2, '0')}`;
  }

  if (minutePart === '0' && hourPart === '*' && allWild) return 'Every hour';

  const minute = parseCronNumber(minutePart, 59);
  const hour = parseCronNumber(hourPart, 23);
  if (minute === null || hour === null || monthPart !== '*') return null;
  const time = formatCronTime(hour, minute);

  if (dayPart !== '*' && weekdayPart === '*') {
    const day = parseCronNumber(dayPart, 31);
    if (day !== null && day >= 1) return `Monthly on the ${dayOrdinal(day)} at ${time}`;
    return null;
  }
  if (dayPart !== '*') return null;

  if (weekdayPart === '*') return `Daily at ${time}`;
  if (weekdayPart === '1-5') return `Weekdays at ${time}`;
  if (weekdayPart === '0,6' || weekdayPart === '6,0') return `Weekends at ${time}`;

  const weekday = parseCronNumber(weekdayPart, 7);
  if (weekday !== null) return `Weekly on ${WEEKDAY_NAMES[weekday % 7]} at ${time}`;

  const weekdayList = parseWeekdayList(weekdayPart);
  if (weekdayList && weekdayList.length > 0) {
    const days = weekdayList.map((n) => `${WEEKDAY_NAMES[n]}s`);
    return `${joinWithAnd(days)} at ${time}`;
  }

  return null;
}

function humanizeSchedule(raw: string): string | null {
  const trimmed = raw.trim();
  const interval = detectInterval(trimmed);
  if (interval) return intervalSummary(Number.parseInt(interval.intervalValue, 10), interval.intervalUnit);
  return humanizeCron(trimmed);
}

export function intervalToken(minutes: number): { value: number; unit: IntervalUnit } {
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: 'd' };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: 'h' };
  return { value: minutes, unit: 'm' };
}

export function intervalLabel(minutes: number): string {
  const token = intervalToken(minutes);
  return `every ${token.value}${token.unit}`;
}

export function scheduleRaw(scheduledTask: ScheduledTask): string {
  const schedule = scheduledTask.schedule;
  if (!schedule) return '';
  if (schedule.kind === 'cron' && typeof schedule.expr === 'string') return schedule.expr;
  if (schedule.kind === 'interval' && typeof schedule.minutes === 'number') return intervalLabel(schedule.minutes);
  if (schedule.kind === 'once' && typeof schedule.run_at === 'string') return schedule.run_at;
  return scheduledTask.scheduleDisplay ?? '';
}

function timeFromParts(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseCronTime(raw: string): { minute: string; hour: string; weekday?: string } | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  return { minute: parts[0], hour: parts[1], weekday: parts[4] };
}

function durationMinutes(raw: string): number | null {
  const match = raw.trim().toLowerCase().match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2][0];
  if (!Number.isFinite(value) || value <= 0) return null;
  if (unit === 'h') return value * 60;
  if (unit === 'd') return value * 1440;
  return value;
}

function detectInterval(raw: string): Pick<ScheduleFormFields, 'intervalValue' | 'intervalUnit'> | null {
  const match = raw.trim().toLowerCase().match(/^every\s+(.+)$/);
  if (!match) return null;
  const minutes = durationMinutes(match[1]);
  if (minutes === null) return null;
  const token = intervalToken(minutes);
  return { intervalValue: String(token.value), intervalUnit: token.unit };
}

export function detectPreset(rawSchedule: string): ScheduleFormFields {
  const raw = rawSchedule.trim();
  const cronTime = parseCronTime(raw);
  const time = cronTime ? timeFromParts(Number(cronTime.hour), Number(cronTime.minute)) : '09:00';
  const interval = detectInterval(raw);

  if (interval) {
    return {
      preset: 'interval',
      time: '09:00',
      weekday: '1',
      ...interval,
      rawSchedule: raw,
    };
  }
  if (cronTime && raw.endsWith('* * 1-5')) {
    return { preset: 'weekdays', time, weekday: '1', intervalValue: '2', intervalUnit: 'h', rawSchedule: raw };
  }
  if (cronTime && raw.endsWith('* * *')) {
    return { preset: 'daily', time, weekday: '1', intervalValue: '2', intervalUnit: 'h', rawSchedule: raw };
  }
  if (cronTime && /^\d+$/.test(cronTime.weekday ?? '') && raw.includes('* *')) {
    return { preset: 'weekly', time, weekday: cronTime.weekday ?? '1', intervalValue: '2', intervalUnit: 'h', rawSchedule: raw };
  }

  const legacyIntervalMatch = raw.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (legacyIntervalMatch) {
    return { preset: 'interval', time: '09:00', weekday: '1', intervalValue: legacyIntervalMatch[1], intervalUnit: 'h', rawSchedule: raw };
  }

  return { preset: 'custom', time, weekday: '1', intervalValue: '2', intervalUnit: 'h', rawSchedule: raw || '0 9 * * 1-5' };
}

function splitTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map((part) => Number.parseInt(part, 10));
  return {
    hour: Number.isFinite(hour) ? hour : 9,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}

export function compileSchedule(form: ScheduleFormFields): string {
  const { hour, minute } = splitTime(form.time);
  if (form.preset === 'daily') return `${minute} ${hour} * * *`;
  if (form.preset === 'weekdays') return `${minute} ${hour} * * 1-5`;
  if (form.preset === 'weekly') return `${minute} ${hour} * * ${form.weekday}`;
  if (form.preset === 'interval') {
    const value = Math.max(1, Number.parseInt(form.intervalValue, 10) || 1);
    return `every ${value}${form.intervalUnit}`;
  }
  return form.rawSchedule.trim();
}

export interface NextRunPreview {
  date: Date | null;
  invalid: boolean;
  uncertain?: boolean;
}

export function nextRunPreview(form: ScheduleFormFields, schedule: string): NextRunPreview {
  const raw = schedule.trim();
  if (!raw) return { date: null, invalid: true };
  if (form.preset === 'interval') {
    const minutes = durationMinutes(`${form.intervalValue}${form.intervalUnit}`);
    return minutes === null
      ? { date: null, invalid: true }
      : { date: new Date(Date.now() + minutes * 60_000), invalid: false };
  }
  const intervalRaw = raw.toLowerCase().startsWith('every ') ? raw.slice(6).trim() : raw;
  const intervalMinutes = durationMinutes(intervalRaw);
  if (intervalMinutes !== null) {
    return { date: new Date(Date.now() + intervalMinutes * 60_000), invalid: false };
  }
  const date = nextRun(raw);
  if (date) return { date, invalid: false };
  return form.preset === 'custom' ? { date: null, invalid: false, uncertain: true } : { date: null, invalid: true };
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSeconds);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];

  for (const [unit, seconds] of units) {
    if (abs >= seconds) return RELATIVE_TIME_FORMATTER.format(Math.round(diffSeconds / seconds), unit);
  }
  return RELATIVE_TIME_FORMATTER.format(diffSeconds, 'second');
}
