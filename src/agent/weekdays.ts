// The names of the days of the week, from Sunday, and of the months, as a language writes a date
interface Names {
	readonly weekdays: readonly string[];
	readonly months: readonly string[];
}

const FRENCH: Names = {
	weekdays: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
	months: [
		'janvier',
		'février',
		'mars',
		'avril',
		'mai',
		'juin',
		'juillet',
		'août',
		'septembre',
		'octobre',
		'novembre',
		'décembre'
	]
};

const ENGLISH: Names = {
	weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
	months: [
		'January',
		'February',
		'March',
		'April',
		'May',
		'June',
		'July',
		'August',
		'September',
		'October',
		'November',
		'December'
	]
};

// One way of a language to write a date its day is named before, which the pattern finds with its
// weekday, day, month and year, when written
interface Writing {
	readonly names: Names;
	readonly pattern: RegExp;
}

function writing(names: Names, datePattern: string): Writing {
	return {
		names,
		pattern: new RegExp(
			`(?<![\\p{L}\\p{N}])(?<weekday>${names.weekdays.join('|')})${datePattern}(?![\\p{L}\\p{N}])`,
			'giu'
		)
	};
}

const WRITINGS: readonly Writing[] = [
	// « mardi 13 octobre 2026 », « mardi 13 octobre », « jeudi 1er octobre », « mardi, 13 octobre »,
	// « mardi le 13 octobre »
	writing(
		FRENCH,
		`,?\\s+(?:le\\s+)?(?<day>\\d{1,2})(?:er)?\\s+(?<month>${FRENCH.months.join('|')})(?:\\s+(?<year>\\d{4}))?`
	),
	// "Tuesday, October 13, 2026", "Tuesday October 13th"
	writing(
		ENGLISH,
		`,?\\s+(?<month>${ENGLISH.months.join('|')})\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(?<year>\\d{4}))?`
	),
	// "Tuesday 13 October 2026", "Tuesday, the 13th of October"
	writing(
		ENGLISH,
		`,?\\s+(?:the\\s+)?(?<day>\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?<month>${ENGLISH.months.join('|')})(?:,?\\s+(?<year>\\d{4}))?`
	)
];

interface WrittenDate {
	readonly weekday?: string;
	readonly day?: string;
	readonly month?: string;
	readonly year?: string;
}

const DAY_MS = 86_400_000;

// How far from the owner's day a date written without its year may be, in days, in the year it is
// read in: half a year, before or after
const NEAREST_DAYS = 183;

// A date of the calendar, as the time since 1970 at its midnight in UTC; null for one there is not
function dayOf(year: number, month: number, day: number): number | null {
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() : null;
}

function weekdayAt(day: number): number {
	return new Date(day).getUTCDay();
}

// The day of the week a date names, from 0 for Sunday, given the one the model wrote: from its year
// when written, and otherwise from the year nearest to the owner's day, unless the model's day is
// that of the date in another year near it, as the 13th of a month half a year away may be; null
// for a date there is not
function trueWeekday(
	written: number,
	date: { readonly day: number; readonly month: number; readonly year: number | null },
	today: string
): number | null {
	if (date.year !== null) {
		const day = dayOf(date.year, date.month, date.day);
		return day === null ? null : weekdayAt(day);
	}
	const from = Date.parse(`${today}T00:00:00Z`);
	const year = new Date(from).getUTCFullYear();
	const near = [year - 1, year, year + 1]
		.map((candidate) => dayOf(candidate, date.month, date.day))
		.filter((day): day is number => day !== null && Math.abs(day - from) <= NEAREST_DAYS * DAY_MS)
		.sort((a, b) => Math.abs(a - from) - Math.abs(b - from));
	if (near.length === 0) return null;
	if (near.some((day) => weekdayAt(day) === written)) return written;
	return weekdayAt(near[0] ?? from);
}

// The place of a name in a list of them, whatever its case; -1 for none
function indexOf(names: readonly string[], name: string): number {
	return names.findIndex((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

// A name in the case of the one it replaces: in capitals, with a capital first, or in lower case
function casedAs(name: string, written: string): string {
	if (written.length > 1 && written === written.toUpperCase()) return name.toUpperCase();
	const lower = name.toLowerCase();
	const first = written.charAt(0);
	return first === first.toUpperCase()
		? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`
		: lower;
}

// The model's words with the day of each date they write named from the date itself, a date
// without its year read in the year nearest to the owner's day, as ISO 8601 writes it: a model
// works that name out from the date, and gets it wrong
export function withTrueWeekdays(text: string, today: string): string {
	return WRITINGS.reduce(
		(words, { names, pattern }) =>
			words.replace(pattern, (written: string, ...rest: unknown[]) => {
				const { weekday: named = '', day = '', month = '', year } = rest.at(-1) as WrittenDate;
				const weekday = trueWeekday(
					indexOf(names.weekdays, named),
					{
						day: Number(day),
						month: indexOf(names.months, month) + 1,
						year: year === undefined ? null : Number(year)
					},
					today
				);
				const name = weekday === null ? undefined : names.weekdays[weekday];
				return name === undefined
					? written
					: `${casedAs(name, named)}${written.slice(named.length)}`;
			}),
		text
	);
}
