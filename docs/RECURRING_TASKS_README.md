# Recurring Tasks - Complete Implementation Guide

## Quick Start

### Create a Recurring Task

```bash
curl -X POST http://localhost:8787/api/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "title": "Daily standup",
    "recurrence_rule": "FREQ=DAILY",
    "due_date": "2025-01-15",
    "status": "scheduled"
  }'
```

### Complete a Task (Auto-Spawns Next)

```bash
curl -X PATCH http://localhost:8787/api/tasks/TASK_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"status": "completed"}'
```

Response includes `spawned_task_id` if successful.

## Features

### 1. Auto-Spawn on Completion
When you mark a recurring task as completed, the system automatically creates the next instance.

### 2. Scheduled Job
Runs daily at midnight UTC to spawn any overdue recurring tasks (safety net).

### 3. Manual Spawn
Create the next instance without completing the current task:
```bash
POST /api/tasks/:id/spawn-next
```

### 4. Validation
Validate recurrence rules before creating tasks:
```bash
POST /api/tasks/validate-recurrence
```

### 5. History Tracking
View all tasks in a recurrence chain:
```bash
GET /api/tasks/:id/recurrence-history
```

## RRULE Format

### Basic Syntax
```
FREQ=<type>[;INTERVAL=<n>][;BYDAY=<days>][;COUNT=<n>][;UNTIL=<date>]
```

### Supported Frequencies
- `DAILY` - Every day
- `WEEKLY` - Every week
- `MONTHLY` - Every month
- `YEARLY` - Every year

### Parameters
- `INTERVAL` - Every N occurrences (default: 1)
- `BYDAY` - Days of week (MO, TU, WE, TH, FR, SA, SU)
- `COUNT` - Maximum number of occurrences
- `UNTIL` - End date (ISO 8601 format: YYYY-MM-DD)

### Examples

```typescript
// Daily
"FREQ=DAILY"                          // Every day
"FREQ=DAILY;INTERVAL=3"               // Every 3 days

// Weekly
"FREQ=WEEKLY"                         // Every week (same day)
"FREQ=WEEKLY;BYDAY=MO,WE,FR"          // Monday, Wednesday, Friday
"FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"     // Every other Monday

// Weekdays only
"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"

// Monthly
"FREQ=MONTHLY"                        // Every month (same day)
"FREQ=MONTHLY;INTERVAL=3"             // Quarterly

// Yearly
"FREQ=YEARLY"                         // Every year

// With limits
"FREQ=DAILY;COUNT=30"                 // 30 days only
"FREQ=WEEKLY;UNTIL=2025-12-31"        // Until end of year
```

## Common Use Cases

### 1. Daily Habits
```json
{
  "title": "Morning meditation",
  "recurrence_rule": "FREQ=DAILY",
  "due_date": "2025-01-15",
  "time_estimate_minutes": 10,
  "energy_required": "low"
}
```

### 2. Work Meetings
```json
{
  "title": "Team standup",
  "recurrence_rule": "FREQ=WEEKLY;BYDAY=MO,WE,FR",
  "due_date": "2025-01-15",
  "due_time": "09:00:00",
  "domain": "work",
  "importance": 4
}
```

### 3. Monthly Reviews
```json
{
  "title": "Budget review",
  "recurrence_rule": "FREQ=MONTHLY",
  "due_date": "2025-01-31",
  "time_estimate_minutes": 60
}
```

### 4. Challenges
```json
{
  "title": "30-day fitness challenge",
  "recurrence_rule": "FREQ=DAILY;COUNT=30",
  "due_date": "2025-01-15"
}
```

### 5. Quarterly Reports
```json
{
  "title": "Quarterly report",
  "recurrence_rule": "FREQ=MONTHLY;INTERVAL=3",
  "due_date": "2025-01-31",
  "domain": "work"
}
```

## How It Works

### Auto-Spawn Flow

1. User marks task as completed: `PATCH /api/tasks/:id {"status": "completed"}`
2. System checks if task has `recurrence_rule`
3. Calculates next due date based on RRULE
4. Verifies COUNT and UNTIL limits
5. Creates new task instance with next due date
6. Links via `recurrence_parent_id`
7. Returns `spawned_task_id` in response

### Scheduled Job Flow

1. Cron trigger fires at midnight UTC
2. Queries all tenants from database
3. For each tenant:
   - Fetches all tasks with `recurrence_rule`
   - Checks if each task is due to spawn
   - Spawns new instances if criteria met
4. Logs results for monitoring

### Spawning Criteria

A task is spawned if:
- Has valid `recurrence_rule`
- Is completed OR is the original parent task
- Next calculated date is today or earlier
- COUNT limit not exceeded
- UNTIL date not exceeded

## API Reference

### POST /api/tasks
Create a new task with recurrence rule.

**Request:**
```json
{
  "title": "Daily standup",
  "recurrence_rule": "FREQ=DAILY",
  "due_date": "2025-01-15"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid-here"
  }
}
```

### PATCH /api/tasks/:id
Update a task. When `status` changes to `completed`, auto-spawns next instance.

**Request:**
```json
{
  "status": "completed"
}
```

**Response:**
```json
{
  "success": true,
  "spawned_task_id": "uuid-of-next-instance"
}
```

### POST /api/tasks/:id/spawn-next
Manually spawn the next instance without completing current task.

**Response:**
```json
{
  "success": true,
  "data": {
    "spawned_task_id": "uuid-of-next-instance"
  }
}
```

### POST /api/tasks/validate-recurrence
Validate a recurrence rule.

**Request:**
```json
{
  "recurrence_rule": "FREQ=WEEKLY;BYDAY=MO,WE,FR"
}
```

**Response:**
```json
{
  "success": true,
  "valid": true,
  "description": "Repeats every week on MO, WE, FR"
}
```

### GET /api/tasks/:id/recurrence-history
Get all tasks in a recurrence chain.

**Response:**
```json
{
  "success": true,
  "data": {
    "parent_id": "uuid-of-parent",
    "total_instances": 5,
    "tasks": [
      {
        "id": "uuid-1",
        "title": "Daily standup",
        "due_date": "2025-01-15",
        "status": "completed",
        "recurrence_parent_id": null
      },
      {
        "id": "uuid-2",
        "title": "Daily standup",
        "due_date": "2025-01-16",
        "status": "scheduled",
        "recurrence_parent_id": "uuid-1"
      }
    ]
  }
}
```

## Deployment

### 1. Apply Database Migration (Optional)
```bash
npm run db:migrate:remote
```

This adds performance indexes but is not required for functionality.

### 2. Deploy to Cloudflare
```bash
npm run deploy
```

The cron trigger is automatically configured.

### 3. Monitor Logs
```bash
npx wrangler tail
```

Look for:
```
Starting recurring tasks processing...
Spawned recurring task {id} from {parent} with due_date {date}
Recurring tasks processing complete. Spawned X tasks.
```

## Configuration

### Cron Schedule
Default: Daily at midnight UTC (`0 0 * * *`)

To change, edit `wrangler.toml`:
```toml
[triggers]
crons = ["0 0 * * *"]  # Daily at midnight
# crons = ["0 */6 * * *"]  # Every 6 hours
# crons = ["0 * * * *"]  # Every hour
```

### Environment Variables
No additional configuration needed. Uses existing:
- `DB` - D1 database
- `KV` - Encryption keys
- `ENVIRONMENT` - Environment name

## Testing

### Run Tests
```bash
# All tests
npm test

# Watch mode
npm run test:watch

# Specific test
npm test test/recurrence.test.ts
```

### Test Results
```
✓ test/recurrence.test.ts (32 tests | 2 skipped)
✓ test/scheduled-recurring.test.ts (10 tests)
✓ test/validation.test.ts (27 tests)
✓ test/api.test.ts (7 tests)

Tests: 97 passed | 4 skipped (101)
```

### Manual Testing
```bash
# 1. Start dev server
npm run dev

# 2. Create recurring task
curl -X POST http://localhost:8787/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test task",
    "recurrence_rule": "FREQ=DAILY",
    "due_date": "2025-01-15"
  }'

# 3. Complete it
curl -X PATCH http://localhost:8787/api/tasks/TASK_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'

# 4. Check response for spawned_task_id

# 5. Verify history
curl http://localhost:8787/api/tasks/TASK_ID/recurrence-history
```

## Troubleshooting

### Task Not Spawning

**Check:**
1. Does task have valid `recurrence_rule`?
2. Is next date today or earlier?
3. Has COUNT limit been reached?
4. Has UNTIL date been exceeded?
5. Check logs: `npx wrangler tail`

### Validate Rule First
```bash
curl -X POST http://localhost:8787/api/tasks/validate-recurrence \
  -d '{"recurrence_rule": "YOUR_RULE_HERE"}'
```

### Cron Not Running

**Check:**
1. Has Worker been deployed?
2. Is cron syntax valid in `wrangler.toml`?
3. Check Cloudflare dashboard > Workers > Triggers
4. View logs: `npx wrangler tail`

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| Invalid FREQ | Unsupported frequency | Use DAILY, WEEKLY, MONTHLY, or YEARLY |
| Invalid BYDAY | Unknown weekday code | Use MO, TU, WE, TH, FR, SA, SU |
| Missing FREQ | FREQ not provided | Add FREQ=<type> to rule |
| spawned_task_id: null | Recurrence exhausted | Check COUNT/UNTIL limits |

## Security

- Title and description encrypted at app layer
- All queries scoped to `tenant_id`
- User ownership verified before operations
- Parameterized SQL queries only
- Encryption keys stored in KV namespace

## Performance

### Indexes
Three indexes optimize recurring task queries:
- `idx_tasks_recurrence` - General recurring task queries
- `idx_tasks_due_recurrence` - Scheduled job queries
- `idx_tasks_recurrence_parent` - Chain history queries

### Scheduled Job Efficiency
- Processes only tasks with `recurrence_rule`
- Decrypts only needed tasks
- Sequential tenant processing
- Logs errors but continues

## Documentation

### Full Guides
- `/home/chris/nexus/docs/features/RecurringTasks.md` - Complete guide
- `/home/chris/nexus/docs/features/RecurringTasks-QuickRef.md` - Quick reference
- `/home/chris/nexus/docs/features/RecurringTasks-Scheduled.md` - Cron guide

### Code Examples
- `/home/chris/nexus/examples/recurring-tasks-example.ts` - Usage examples

### Implementation
- `/home/chris/nexus/src/lib/recurrence.ts` - Core logic
- `/home/chris/nexus/src/routes/tasks.ts` - API endpoints
- `/home/chris/nexus/src/scheduled/recurring-tasks.ts` - Scheduled job

## Support

For issues or questions:
1. Check the full documentation in `/home/chris/nexus/docs/features/`
2. Review test files for examples
3. Check logs with `npx wrangler tail`
4. Review the implementation summary in `RECURRING_TASKS_IMPLEMENTATION_SUMMARY.md`

## Summary

The Recurring Tasks feature is **fully implemented and production-ready**:

✅ Complete RRULE parsing (FREQ, INTERVAL, BYDAY, COUNT, UNTIL)
✅ Auto-spawn on task completion
✅ Scheduled job for safety net
✅ Manual spawn capability
✅ Validation and error handling
✅ History tracking
✅ Comprehensive tests (97 passing)
✅ Full documentation
✅ Security (encryption, tenant scoping)
✅ Performance optimized (indexes)

**Ready to use in production!**
