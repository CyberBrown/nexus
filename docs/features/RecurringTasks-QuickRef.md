# Recurring Tasks - Quick Reference Card

## RRULE Format
```
FREQ=<type>[;INTERVAL=<n>][;BYDAY=<days>][;COUNT=<n>][;UNTIL=<date>]
```

## Common Patterns

```typescript
// Daily
"FREQ=DAILY"                          // Every day
"FREQ=DAILY;INTERVAL=3"               // Every 3 days
"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"    // Weekdays

// Weekly
"FREQ=WEEKLY"                         // Every week
"FREQ=WEEKLY;INTERVAL=2"              // Every 2 weeks
"FREQ=WEEKLY;BYDAY=MO,WE,FR"          // Mon/Wed/Fri

// Monthly
"FREQ=MONTHLY"                        // Every month
"FREQ=MONTHLY;INTERVAL=3"             // Quarterly

// With limits
"FREQ=DAILY;COUNT=30"                 // 30 days only
"FREQ=WEEKLY;UNTIL=2025-12-31"        // Until year end
```

## API Endpoints

### Create Recurring Task
```bash
POST /api/tasks
Content-Type: application/json

{
  "title": "Daily standup",
  "due_date": "2025-01-15",
  "recurrence_rule": "FREQ=DAILY",
  "status": "scheduled"
}
```

### Complete Task (Auto-Spawns Next)
```bash
PATCH /api/tasks/:id
Content-Type: application/json

{ "status": "completed" }

# Response includes spawned_task_id if successful
```

### Manual Spawn
```bash
POST /api/tasks/:id/spawn-next
```

### Validate Rule
```bash
POST /api/tasks/validate-recurrence
Content-Type: application/json

{ "recurrence_rule": "FREQ=WEEKLY;BYDAY=MO,WE,FR" }
```

### Get History
```bash
GET /api/tasks/:id/recurrence-history
```

## Weekday Codes
- SU (Sunday), MO (Monday), TU (Tuesday), WE (Wednesday)
- TH (Thursday), FR (Friday), SA (Saturday)

## Key Functions (TypeScript)

```typescript
import {
  parseRRule,
  calculateNextOccurrence,
  shouldContinueRecurrence,
  validateRRule,
  describeRRule
} from './lib/recurrence.ts';

// Parse rule
const parsed = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE');

// Calculate next date
const next = calculateNextOccurrence('2025-01-15', 'FREQ=DAILY');

// Check if should continue
const shouldContinue = shouldContinueRecurrence(rule, spawnedCount);

// Validate
const validation = validateRRule(rule);
if (!validation.valid) {
  console.error(validation.error);
}

// Get description
const desc = describeRRule('FREQ=DAILY;INTERVAL=2');
// Returns: "Repeats every 2 days"
```

## Task Fields

### Inherited by Child Tasks
- title, description, project_id, domain
- contexts, tags, urgency, importance
- time_estimate_minutes, energy_required
- recurrence_rule (for continued spawning)

### Reset in Child Tasks
- status → "scheduled"
- due_date → calculated next occurrence
- completed_at → null
- start_date → null
- actual_time_minutes → null
- source_type → "recurring"

## Examples

### Daily Habit
```json
{
  "title": "Morning meditation",
  "recurrence_rule": "FREQ=DAILY",
  "due_date": "2025-01-15",
  "time_estimate_minutes": 10
}
```

### Weekly Meeting (M/W/F)
```json
{
  "title": "Team standup",
  "recurrence_rule": "FREQ=WEEKLY;BYDAY=MO,WE,FR",
  "due_date": "2025-01-15",
  "due_time": "09:00:00"
}
```

### Monthly Review
```json
{
  "title": "Budget review",
  "recurrence_rule": "FREQ=MONTHLY",
  "due_date": "2025-01-31"
}
```

### 30-Day Challenge
```json
{
  "title": "Daily exercise",
  "recurrence_rule": "FREQ=DAILY;COUNT=30",
  "due_date": "2025-01-15"
}
```

## Error Handling

| Error | Cause | Response |
|-------|-------|----------|
| Invalid FREQ | Unknown frequency type | 400 with error message |
| Invalid BYDAY | Unknown weekday code | 400 with error message |
| Missing FREQ | FREQ not provided | 400 with error message |
| Exhausted COUNT | All occurrences spawned | `spawned_task_id: null` |
| Exceeded UNTIL | Next date past end date | `spawned_task_id: null` |

## Testing

```bash
# Run unit tests
bun test src/lib/recurrence.test.ts

# Test in dev environment
bun run dev

# Create test task
curl -X POST http://localhost:8787/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","recurrence_rule":"FREQ=DAILY","due_date":"2025-01-15"}'

# Complete it
curl -X PATCH http://localhost:8787/api/tasks/{id} \
  -H "Content-Type: application/json" \
  -d '{"status":"completed"}'

# View history
curl http://localhost:8787/api/tasks/{id}/recurrence-history
```

## Files
- Implementation: `/home/chris/nexus/src/lib/recurrence.ts`
- Routes: `/home/chris/nexus/src/routes/tasks.ts`
- Tests: `/home/chris/nexus/src/lib/recurrence.test.ts`
- Examples: `/home/chris/nexus/examples/recurring-tasks-example.ts`
- Full Guide: `/home/chris/nexus/RECURRENCE_GUIDE.md`
