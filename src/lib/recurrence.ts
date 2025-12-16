// Recurrence rule parsing and next occurrence calculation
// Supports RRULE format: FREQ, INTERVAL, BYDAY, COUNT, UNTIL

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byday?: string[]; // ["MO", "WE", "FR"]
  count?: number;
  until?: Date;
}

export interface ParsedRRule extends RecurrenceRule {
  originalRule: string;
}

const WEEKDAY_MAP: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/**
 * Parse RRULE string into structured format
 * Example: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR"
 */
export function parseRRule(rrule: string): ParsedRRule {
  const parts = rrule.split(';');
  const rule: Partial<RecurrenceRule> = {
    interval: 1, // default
  };

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (!value) continue; // Skip malformed parts

    switch (key) {
      case 'FREQ':
        if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(value)) {
          throw new Error(`Invalid frequency: ${value}`);
        }
        rule.freq = value as RecurrenceRule['freq'];
        break;

      case 'INTERVAL':
        rule.interval = parseInt(value, 10);
        if (isNaN(rule.interval) || rule.interval < 1) {
          throw new Error(`Invalid interval: ${value}`);
        }
        break;

      case 'BYDAY':
        rule.byday = value.split(',').map((day) => day.trim().toUpperCase());
        // Validate weekday codes
        for (const day of rule.byday) {
          if (!Object.prototype.hasOwnProperty.call(WEEKDAY_MAP, day)) {
            throw new Error(`Invalid weekday: ${day}`);
          }
        }
        break;

      case 'COUNT':
        rule.count = parseInt(value, 10);
        if (isNaN(rule.count) || rule.count < 1) {
          throw new Error(`Invalid count: ${value}`);
        }
        break;

      case 'UNTIL': {
        const until = new Date(value);
        if (isNaN(until.getTime())) {
          throw new Error(`Invalid until date: ${value}`);
        }
        rule.until = until;
        break;
      }
    }
  }

  if (!rule.freq) {
    throw new Error('FREQ is required in recurrence rule');
  }

  return {
    ...rule,
    originalRule: rrule,
  } as ParsedRRule;
}

/**
 * Calculate the next occurrence date based on recurrence rule
 * @param currentDate - The current/last due date (ISO string or Date)
 * @param rrule - The recurrence rule string
 * @returns ISO string of next occurrence, or null if recurrence is exhausted
 */
export function calculateNextOccurrence(
  currentDate: string | Date,
  rrule: string
): string | null {
  const parsed = parseRRule(rrule);
  const current = typeof currentDate === 'string' ? new Date(currentDate) : currentDate;

  if (isNaN(current.getTime())) {
    throw new Error(`Invalid current date: ${currentDate}`);
  }

  let next = new Date(current);

  switch (parsed.freq) {
    case 'DAILY':
      next = addDays(next, parsed.interval);
      break;

    case 'WEEKLY':
      if (parsed.byday && parsed.byday.length > 0) {
        next = nextWeekdayOccurrence(next, parsed.byday, parsed.interval);
      } else {
        next = addWeeks(next, parsed.interval);
      }
      break;

    case 'MONTHLY':
      next = addMonths(next, parsed.interval);
      break;

    case 'YEARLY':
      next = addYears(next, parsed.interval);
      break;
  }

  // Check if we've exceeded UNTIL
  if (parsed.until && next > parsed.until) {
    return null;
  }

  return next.toISOString();
}

/**
 * Check if recurrence should continue based on COUNT
 * @param recurrenceParentId - The parent task ID
 * @param rrule - The recurrence rule string
 * @param spawnedCount - Number of instances already spawned
 */
export function shouldContinueRecurrence(
  rrule: string,
  spawnedCount: number
): boolean {
  const parsed = parseRRule(rrule);

  // If COUNT is specified, check if we've reached it
  if (parsed.count !== undefined) {
    return spawnedCount < parsed.count;
  }

  // If UNTIL is specified, it will be checked in calculateNextOccurrence
  // If neither COUNT nor UNTIL is specified, recur indefinitely
  return true;
}

// Date manipulation helpers

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function addWeeks(date: Date, weeks: number): Date {
  return addDays(date, weeks * 7);
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

function addYears(date: Date, years: number): Date {
  const result = new Date(date);
  result.setUTCFullYear(result.getUTCFullYear() + years);
  return result;
}

/**
 * Find the next occurrence of specified weekdays
 * @param fromDate - Starting date
 * @param weekdays - Array of weekday codes ["MO", "WE", "FR"]
 * @param interval - Week interval
 */
function nextWeekdayOccurrence(
  fromDate: Date,
  weekdays: string[],
  interval: number
): Date {
  // Map weekday codes to day numbers (already validated in parseRRule)
  const targetDays = weekdays
    .map((day) => WEEKDAY_MAP[day])
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b);

  if (targetDays.length === 0) {
    // Fallback: no valid weekdays, return next week
    return addDays(fromDate, 7 * interval);
  }

  const currentDay = fromDate.getUTCDay();

  // Find next occurrence in current week
  for (const targetDay of targetDays) {
    if (targetDay > currentDay) {
      const daysToAdd = targetDay - currentDay;
      return addDays(fromDate, daysToAdd);
    }
  }

  // No occurrence in current week, go to next interval week
  const firstTargetDay = targetDays[0]!;
  const daysUntilNextWeek = 7 * interval - currentDay + firstTargetDay;
  return addDays(fromDate, daysUntilNextWeek);
}

/**
 * Validate a recurrence rule string
 */
export function validateRRule(rrule: string): { valid: boolean; error?: string } {
  try {
    parseRRule(rrule);
    return { valid: true };
  } catch (error) {
    return { valid: false, error: (error as Error).message };
  }
}

/**
 * Generate human-readable description of recurrence rule
 */
export function describeRRule(rrule: string): string {
  try {
    const parsed = parseRRule(rrule);
    let description = '';

    const intervalText = parsed.interval === 1 ? '' : `every ${parsed.interval} `;

    switch (parsed.freq) {
      case 'DAILY':
        description = `${intervalText}day${parsed.interval === 1 ? '' : 's'}`;
        break;

      case 'WEEKLY':
        if (parsed.byday && parsed.byday.length > 0) {
          const days = parsed.byday.join(', ');
          description = `${intervalText}week${parsed.interval === 1 ? '' : 's'} on ${days}`;
        } else {
          description = `${intervalText}week${parsed.interval === 1 ? '' : 's'}`;
        }
        break;

      case 'MONTHLY':
        description = `${intervalText}month${parsed.interval === 1 ? '' : 's'}`;
        break;

      case 'YEARLY':
        description = `${intervalText}year${parsed.interval === 1 ? '' : 's'}`;
        break;
    }

    if (parsed.count) {
      description += ` (${parsed.count} times)`;
    } else if (parsed.until) {
      description += ` until ${parsed.until.toLocaleDateString()}`;
    }

    return `Repeats ${description}`;
  } catch {
    return 'Invalid recurrence rule';
  }
}
