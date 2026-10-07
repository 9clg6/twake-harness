import { describe, expect, it } from 'vitest';

import { invitationSlot } from '../src/agent/invitation.js';

// What read_freebusy is asked: the invitation's own start and end, as RFC 3339 times with their
// offset, or the reason why the slot cannot be checked. The invitation's wake-up carries start and
// end from DTSTART and DTEND, in one of several shapes.
describe("an invitation's slot, for the free/busy check", () => {
	it('keeps a time that already carries its offset', () => {
		expect(
			invitationSlot(
				{
					start: '2026-10-13T17:00:00+02:00',
					end: '2026-10-13T18:00:00+02:00',
					timezone: 'Europe/Paris'
				},
				'UTC'
			)
		).toEqual({ ok: true, start: '2026-10-13T17:00:00+02:00', end: '2026-10-13T18:00:00+02:00' });
	});

	it('keeps a time in UTC as it is written, with its Z', () => {
		expect(
			invitationSlot(
				{ start: '2026-10-13T15:00:00Z', end: '2026-10-13T16:00:00Z', timezone: 'UTC' },
				'Europe/Paris'
			)
		).toEqual({ ok: true, start: '2026-10-13T15:00:00Z', end: '2026-10-13T16:00:00Z' });
	});

	it("takes an all-day event from midnight to midnight in the deployment's zone", () => {
		expect(
			invitationSlot({ start: '2026-10-13', end: '2026-10-14', timezone: null }, 'Europe/Paris')
		).toEqual({ ok: true, start: '2026-10-13T00:00:00+02:00', end: '2026-10-14T00:00:00+02:00' });
		expect(
			invitationSlot({ start: '2026-12-01', end: '2026-12-02', timezone: null }, 'Europe/Paris')
		).toEqual({ ok: true, start: '2026-12-01T00:00:00+01:00', end: '2026-12-02T00:00:00+01:00' });
	});

	it('gives each midnight its own offset on the day the clocks go back', () => {
		// In Paris, summer time ends on 25 October 2026 at 03:00
		expect(
			invitationSlot({ start: '2026-10-25', end: '2026-10-26', timezone: null }, 'Europe/Paris')
		).toEqual({ ok: true, start: '2026-10-25T00:00:00+02:00', end: '2026-10-26T00:00:00+01:00' });
	});

	it('gives a wall time the offset of the zone the event names, when the runtime knows it', () => {
		expect(
			invitationSlot(
				{ start: '2026-10-13T17:00:00', end: '2026-10-13T18:30:00', timezone: 'America/New_York' },
				'Europe/Paris'
			)
		).toEqual({ ok: true, start: '2026-10-13T17:00:00-04:00', end: '2026-10-13T18:30:00-04:00' });
	});

	it('does not check a wall time whose zone the runtime does not know', () => {
		expect(
			invitationSlot(
				{ start: '2026-10-13T17:00:00', end: '2026-10-13T18:00:00', timezone: 'Mars/Olympus_Mons' },
				'Europe/Paris'
			)
		).toEqual({
			ok: false,
			reason: 'availability not checked: unknown time zone Mars/Olympus_Mons'
		});
	});

	it('does not check a wall time that names no zone', () => {
		expect(
			invitationSlot(
				{ start: '2026-10-13T17:00:00', end: '2026-10-13T18:00:00', timezone: null },
				'Europe/Paris'
			)
		).toEqual({
			ok: false,
			reason: 'availability not checked: a time without offset and no time zone'
		});
	});

	it('does not guess a length when the event has no end', () => {
		expect(
			invitationSlot(
				{ start: '2026-10-13T17:00:00+02:00', end: null, timezone: 'Europe/Paris' },
				'Europe/Paris'
			)
		).toEqual({ ok: false, reason: 'availability not checked: no end time' });
		expect(
			invitationSlot({ start: null, end: '2026-10-13T18:00:00+02:00', timezone: null }, 'UTC')
		).toEqual({ ok: false, reason: 'availability not checked: no start time' });
	});

	it('never asks for a period the contract refuses', () => {
		expect(
			invitationSlot(
				{ start: '2026-10-13T18:00:00+02:00', end: '2026-10-13T17:00:00+02:00', timezone: null },
				'UTC'
			)
		).toEqual({
			ok: false,
			reason: 'availability not checked: the invitation ends before it starts'
		});
		expect(
			invitationSlot({ start: '2026-10-01', end: '2026-11-15', timezone: null }, 'Europe/Paris')
		).toEqual({ ok: false, reason: 'availability not checked: the invitation lasts over 31 days' });
		expect(
			invitationSlot({ start: 'next Tuesday', end: '2026-10-13T18:00:00Z', timezone: null }, 'UTC')
		).toEqual({ ok: false, reason: 'availability not checked: unreadable start time' });
	});
});
