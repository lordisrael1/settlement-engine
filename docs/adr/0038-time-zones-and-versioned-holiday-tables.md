# 38. Calendars name a time zone, and holiday tables are versioned

Date: 2026-08-16

## Status

Accepted

## Context

The previous model encoded a 5pm Lagos cut-off as a UTC offset computed by hand. That is
correct for West Africa Time, which has no daylight saving, and silently wrong for half the
year in any zone that observes it.

Eid al-Fitr and Eid al-Adha are lunar and are announced by the federal government days
beforehand, often with an extra day declared beside them, so a year's holiday table changes
during that year.

## Decision

`BusinessCalendar` carries an IANA `timeZone` and `cutOffMinutes` in local time. Holidays
arrive as `HolidayCalendar` editions with a `calendarId`, a `revision` and explicit coverage
bounds. The highest revision covering a day wins, and `isCovered` reports whether any table
is held at all.

## Consequences

- The wall-clock-to-instant conversion belongs to the platform's IANA data rather than to a
  remembered subtraction.
- Without revisions, a run before a holiday correction and a replay after it would disagree
  about whether a payment was late, with nothing in the record explaining why.
  `deadlineProvenance` returns the editions consulted, so a conclusion can name them.
- A year with no table is not a year with no holidays. The deadline still computes — a
  missing table can only make a settlement that was never late look late — but the gap is
  now askable rather than silent.
- Costs: `Intl.DateTimeFormat` on the path, cached per zone; a two-pass offset resolution;
  and holiday tables somebody maintains per jurisdiction and year.
