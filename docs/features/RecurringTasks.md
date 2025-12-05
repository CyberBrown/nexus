# Nexus Recurring Tasks Guide

## Overview

The recurring task system allows tasks to automatically spawn new instances based on a recurrence rule. When a recurring task is completed, the system automatically creates the next occurrence.

## Implementation Files

- `/home/chris/nexus/src/lib/recurrence.ts` - Core recurrence logic (RRULE parsing, date calculations)
- `/home/chris/nexus/src/routes/tasks.ts` - Task endpoints with auto-spawn and manual spawn capabilities

## Recurrence Rule Format (RRULE)

Nexus uses a subset of the iCalendar RRULE format:

```
FREQ=<frequency>[;INTERVAL=<n>][;BYDAY=<days>][;COUNT=<n>][;UNTIL=<date>]
```

### Supported Parameters

| Parameter | Required | Description | Example |
|-----------|----------|-------------|---------|
| `FREQ` | Yes | Frequency of recurrence | `DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY` |
| `INTERVAL` | No | Interval between occurrences (default: 1) | `2` for every 2 weeks |
| `BYDAY` | No | Days of week (for WEEKLY) | `MO,WE,FR` |
| `COUNT` | No | Total number of occurrences | `10` |
| `UNTIL` | No | End date (ISO 8601) | `2025-12-31` |

### Example Recurrence Rules

```typescript
// Every day
"FREQ=DAILY"

// Every 3 days
"FREQ=DAILY;INTERVAL=3"

// Every week on Monday and Wednesday
"FREQ=WEEKLY;BYDAY=MO,WE"

// Every 2 weeks on Monday, Wednesday, Friday
"FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR"

// Every month
"FREQ=MONTHLY"

// Every 3 months
"FREQ=MONTHLY;INTERVAL=3"

// Daily for 30 occurrences
"FREQ=DAILY;COUNT=30"

// Weekly until end of year
"FREQ=WEEKLY;UNTIL=2025-12-31"

// Every year
"FREQ=YEARLY"
```

## API Endpoints

### 1. Create a Recurring Task

**POST** `/api/tasks`

```json
{
  "title": "Daily standup",
  "description": "Team sync meeting",
  "domain": "work",
  "status": "scheduled",
  "due_date": "2025-01-15",
  "due_time": "09:00:00",
  "recurrence_rule": "FREQ=DAILY",
  "urgency": 3,
  "importance": 4,
  "energy_required": "medium"
}
```

### 2. Complete a Recurring Task (Auto-Spawn)

**PATCH** `/api/tasks/:id`

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

When you mark a recurring task as completed, the system automatically:
1. Sets `completed_at` timestamp
2. Calculates the next due date based on the recurrence rule
3. Creates a new task instance with the next due date
4. Links the new task via `recurrence_parent_id`
5. Returns the ID of the spawned task (or `null` if recurrence is exhausted)

### 3. Manually Spawn Next Instance

**POST** `/api/tasks/:id/spawn-next`

Use this to create the next occurrence without completing the current task.

**Response:**
```json
{
  "success": true,
  "data": {
    "spawned_task_id": "uuid-of-next-instance"
  }
}
```

### 4. Validate Recurrence Rule

**POST** `/api/tasks/validate-recurrence`

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

### 5. Get Recurrence History

**GET** `/api/tasks/:id/recurrence-history`

Returns all tasks in the recurrence chain (parent + all spawned instances).

**Response:**
```json
{
  "success": true,
  "data": {
    "parent_id": "uuid-of-parent",
    "total_instances": 5,
    "tasks": [
      {
        "id": "...",
        "title": "Daily standup",
        "due_date": "2025-01-15",
        "status": "completed",
        "recurrence_parent_id": null
      },
      {
        "id": "...",
        "title": "Daily standup",
        "due_date": "2025-01-16",
        "status": "completed",
        "recurrence_parent_id": "uuid-of-parent"
      },
      {
        "id": "...",
        "title": "Daily standup",
        "due_date": "2025-01-17",
        "status": "scheduled",
        "recurrence_parent_id": "uuid-of-parent"
      }
    ]
  }
}
```

## How It Works

### Task Spawning Logic

1. **Trigger**: Task status changes to `completed` or manual spawn is requested
2. **Validation**: Check if task has a valid recurrence rule
3. **Parent ID**: Determine the parent (use `recurrence_parent_id` if already a child, otherwise use current task ID)
4. **Count Check**: Query database for existing spawned instances
5. **Limit Check**: If `COUNT` is specified in rule, verify we haven't exceeded it
6. **Date Calculation**: Calculate next due date from current due date + recurrence rule
7. **Until Check**: If `UNTIL` is specified, verify next date doesn't exceed it
8. **Create Instance**: Copy relevant fields from parent task
9. **Link**: Set `recurrence_parent_id` to link to parent
10. **Encrypt**: Encrypt title/description before insertion

### Fields Copied to Child Tasks

- `title`, `description` (encrypted)
- `project_id`, `domain`, `area`
- `contexts`, `tags`
- `due_time` (time of day)
- `time_estimate_minutes`
- `recurrence_rule` (inherited for future spawning)
- `urgency`, `importance`, `energy_required`
- `assigned_by_id`, `assigned_by_name`
- `delegated_to_id`, `delegated_to_name`

### Fields Reset for Child Tasks

- `status`: Set to `scheduled`
- `due_date`: Set to calculated next occurrence
- `start_date`: Reset to `null`
- `completed_at`: Reset to `null`
- `actual_time_minutes`: Reset to `null`
- `waiting_on`, `waiting_since`: Reset to `null`
- `source_type`: Set to `recurring`
- `source_reference`: Set to parent task ID

## Testing

### Test 1: Daily Recurrence

```bash
# Create recurring task
curl -X POST http://localhost:8787/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Morning meditation",
    "domain": "personal",
    "due_date": "2025-01-15",
    "recurrence_rule": "FREQ=DAILY",
    "status": "scheduled"
  }'

# Complete it (should spawn next day's instance)
curl -X PATCH http://localhost:8787/api/tasks/{task-id} \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```

### Test 2: Weekly on Specific Days

```bash
curl -X POST http://localhost:8787/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Team meeting",
    "domain": "work",
    "due_date": "2025-01-15",
    "recurrence_rule": "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    "status": "scheduled"
  }'
```

### Test 3: Monthly with Count Limit

```bash
curl -X POST http://localhost:8787/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Monthly review",
    "domain": "personal",
    "due_date": "2025-01-31",
    "recurrence_rule": "FREQ=MONTHLY;COUNT=12",
    "status": "scheduled"
  }'
```

### Test 4: Validate Recurrence Rule

```bash
curl -X POST http://localhost:8787/api/tasks/validate-recurrence \
  -H "Content-Type: application/json" \
  -d '{"recurrence_rule": "FREQ=WEEKLY;BYDAY=MO,WE,FR"}'
```

## Implementation Details

### Date Calculation Algorithm

**Daily**: Add `INTERVAL` days to current due date

**Weekly**:
- If no `BYDAY`: Add `INTERVAL * 7` days
- If `BYDAY` specified: Find next occurrence of specified weekdays within the interval

**Monthly**: Add `INTERVAL` months (preserves day of month where possible)

**Yearly**: Add `INTERVAL` years

### Recurrence Exhaustion

Recurrence stops when:
1. `COUNT` limit is reached (based on spawned instance count)
2. Next calculated date exceeds `UNTIL` date
3. Manual deletion of recurrence rule

### Security Considerations

- Title and description are encrypted before storage
- All operations require tenant scoping
- User ownership verified before spawning
- Parent task must be accessible to user

## Weekday Codes

| Code | Day |
|------|-----|
| SU | Sunday |
| MO | Monday |
| TU | Tuesday |
| WE | Wednesday |
| TH | Thursday |
| FR | Friday |
| SA | Saturday |

## Error Handling

The system handles errors gracefully:
- Invalid RRULE: Returns 400 with error message
- Recurrence exhausted: Returns `null` for spawned task ID
- Auto-spawn failure: Logs error but doesn't fail task update
- Missing encryption key: Throws error (prevents insecure storage)

## Future Enhancements

Potential future additions:
- `BYMONTHDAY` - Specific days of month
- `BYSETPOS` - Nth occurrence (e.g., "2nd Tuesday of month")
- Timezone support for due dates
- Bulk operations (spawn multiple instances ahead of time)
- Notification/reminder integration
- Recurrence pattern templates

## Database Schema

Relevant columns in `tasks` table:

```sql
recurrence_rule TEXT NULL,           -- RRULE format string
recurrence_parent_id TEXT NULL,      -- UUID of parent task
due_date TEXT NULL,                  -- ISO date (YYYY-MM-DD)
status TEXT NOT NULL,                -- 'scheduled' for new instances
source_type TEXT NULL,               -- 'recurring' for spawned tasks
source_reference TEXT NULL           -- ID of completed task that spawned this
```
