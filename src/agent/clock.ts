import type { Locale } from '../i18n/messages.js';

// The present instant, as the harness asks for it: production reads the system clock, tests pass
// a clock they set by hand
export interface Clock {
	now(): Date;
}

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };

// The canonical name of an IANA time zone the runtime knows, or null for any other name
export function findTimeZone(zone: string): string | null {
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
	} catch {
		return null;
	}
}

// One instant, as a person in the zone reads it and as a contract expects it
export interface Moment {
	// The date and time in words, in the deployment's language: "mardi 6 octobre 2026, 13:26"
	readonly words: string;
	// The same instant in ISO 8601 with the zone's offset at that instant, never Z:
	// "2026-10-06T13:26:00+02:00"
	readonly iso: string;
	readonly timeZone: string;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

function formatOffset(minutes: number): string {
	const sign = minutes < 0 ? '-' : '+';
	const absolute = Math.abs(minutes);
	return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

export function describeMoment(instant: Date, timeZone: string, locale: Locale): Moment {
	const date = new Intl.DateTimeFormat(locale, {
		timeZone,
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric'
	}).format(instant);
	const time = new Intl.DateTimeFormat(locale, {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).format(instant);
	// The wall clock of the zone at this instant; its distance to the instant is the zone's offset
	// then, daylight saving time included, whatever the server's own zone
	const parts = new Map(
		new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23'
		})
			.formatToParts(instant)
			.map((part) => [part.type, part.value])
	);
	const field = (type: Intl.DateTimeFormatPartTypes): string => parts.get(type) ?? '00';
	const wall = Date.UTC(
		Number(field('year')),
		Number(field('month')) - 1,
		Number(field('day')),
		Number(field('hour')),
		Number(field('minute')),
		Number(field('second'))
	);
	const offsetMinutes = Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
	const iso = `${field('year')}-${field('month')}-${field('day')}T${field('hour')}:${field('minute')}:${field('second')}${formatOffset(offsetMinutes)}`;
	return { words: `${date}, ${time}`, iso, timeZone };
}
