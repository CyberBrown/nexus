# Recurring Tasks - Scheduled Processing

## Overview

In addition to auto-spawning recurring tasks when they are completed, Nexus also includes a **scheduled job** that runs automatically via Cloudflare Cron Triggers to spawn recurring tasks at the appropriate times.

## Implementation

### Files

- `/home/chris/nexus/src/scheduled/recurring-tasks.ts` - Scheduled job implementation
- `/home/chris/nexus/src/index.ts` - Exports the `scheduled` handler
- `/home/chris/nexus/wrangler.toml` - Cron trigger configuration

### How It Works

The scheduled job runs **daily at midnight UTC** and performs the following:

1. **Query all tenants** from the database
2. **For each tenant:**
   - Fetch all tasks with `recurrence_rule` set
   - Decrypt the tasks
   - Check if each task is due to spawn a new instance
3. **Spawn logic:**
   - Task must have a `recurrence_rule`
   - Task must be either `completed` OR be the original parent (no `recurrence_parent_id`)
   - The next calculated spawn date must be today or earlier
   - COUNT and UNTIL limits are respected
4. **Create new instance** with calculated due date
5. **Log results** for monitoring

### Spawning Criteria

A recurring task is spawned if:
- It has a valid `recurrence_rule`
- It's either completed or the original parent task
- The calculated next due date is today or earlier
- COUNT limit hasn't been reached
- UNTIL date hasn't been exceeded

### Cron Schedule

**Default**: `0 0 * * *` (Daily at midnight UTC)

You can customize the schedule in `wrangler.toml`:

```toml
[triggers]
crons = ["0 0 * * *"]  # Daily at midnight
```

Common cron patterns:
- `0 * * * *` - Every hour
- `0 */6 * * *` - Every 6 hours
- `0 0 * * *` - Daily at midnight
- `0 0 * * 0` - Weekly on Sunday at midnight

## Configuration

### wrangler.toml

```toml
[triggers]
crons = ["0 0 * * *"]  # Run daily at midnight UTC
```

### Environment Variables

The scheduled job uses the same environment bindings as the Worker:
- `DB` - D1 database connection
- `KV` - KV namespace for encryption keys
- `ENVIRONMENT` - Environment name

## Monitoring

### Logs

The scheduled job logs the following events:

```typescript
// Start
"Starting recurring tasks processing..."

// Per tenant
"Found X recurring tasks for tenant {tenantId}"

// Per spawn
"Spawned recurring task {newTaskId} from {parentId} with due_date {date}"

// COUNT limit
"Recurrence exhausted for task {taskId} (COUNT limit reached)"

// UNTIL limit
"Recurrence exhausted for task {taskId} (UNTIL limit reached)"

// Completion
"Recurring tasks processing complete. Spawned X tasks."
```

### Error Handling

- **Individual task errors**: Logged and skipped, processing continues
- **Fatal errors**: Logged and thrown, job terminates
- **Invalid recurrence rules**: Logged and skipped

## Testing

### Local Testing

The scheduled handler can be triggered locally using Wrangler:

```bash
# Run scheduled trigger manually
npx wrangler dev --test-scheduled

# In another terminal, trigger the cron
curl "http://localhost:8787/__scheduled?cron=0+0+*+*+*"
```

### Unit Tests

```bash
npm test test/scheduled-recurring.test.ts
```

### Integration Testing

1. Create a recurring task with a due date in the past
2. Wait for the cron to run (or trigger manually)
3. Verify the new instance was created
4. Check the logs for confirmation

## Deployment

When you deploy to Cloudflare, the cron trigger is automatically configured:

```bash
npm run deploy
```

To view scheduled triggers:

```bash
npx wrangler deployments list
npx wrangler tail  # View live logs
```

## Example Scenarios

### Scenario 1: Daily Task

**Task**: Morning meditation (FREQ=DAILY)
- Due date: 2025-01-15
- Status: completed
- Cron runs at midnight on 2025-01-16
- **Result**: Spawns new task with due_date=2025-01-16

### Scenario 2: Weekly Task (M/W/F)

**Task**: Gym workout (FREQ=WEEKLY;BYDAY=MO,WE,FR)
- Due date: 2025-01-15 (Wednesday)
- Status: completed
- Cron runs at midnight on 2025-01-16
- **Result**: Spawns new task with due_date=2025-01-17 (Friday)

### Scenario 3: Monthly with COUNT

**Task**: Budget review (FREQ=MONTHLY;COUNT=12)
- Due date: 2025-01-31
- Status: completed
- Spawned instances: 11
- Cron runs at midnight on 2025-02-01
- **Result**: Spawns final (12th) task with due_date=2025-02-28

### Scenario 4: Already Spawned

**Task**: Daily standup (FREQ=DAILY)
- Due date: 2025-01-15
- Status: completed
- Cron ran yesterday and already spawned 2025-01-16 instance
- Cron runs at midnight on 2025-01-16
- **Result**: No action (next instance already exists)

## Interaction with Auto-Spawn

Nexus has **two mechanisms** for spawning recurring tasks:

1. **Auto-spawn on completion** (immediate)
   - Triggers when you mark a task as completed
   - Spawns the next instance immediately
   - Returns `spawned_task_id` in response

2. **Scheduled job** (daily)
   - Runs at midnight UTC
   - Spawns any overdue instances
   - Catches missed spawns if auto-spawn failed

**Best Practice**: The auto-spawn on completion is the primary mechanism. The scheduled job acts as a **safety net** to catch any missed spawns.

## Performance Considerations

- **Multi-tenant**: Processes all tenants sequentially
- **Batching**: Could be optimized to batch insert multiple tasks
- **Encryption**: Decrypts only tasks with recurrence rules
- **Database queries**: Uses indexed queries for efficiency

### Optimization Tips

For high-volume deployments:
1. Add database indexes on `recurrence_rule` and `due_date`
2. Consider limiting processing to active users
3. Implement pagination for large tenant lists
4. Add metrics tracking to monitor execution time

## Troubleshooting

### Problem: Tasks Not Spawning

**Check:**
1. Is the cron trigger configured in `wrangler.toml`?
2. Is the task's `recurrence_rule` valid?
3. Is the calculated next date today or earlier?
4. Has the COUNT or UNTIL limit been reached?
5. Check the Worker logs for errors

### Problem: Duplicate Tasks

**Causes:**
- Cron running multiple times due to retries
- Both auto-spawn and scheduled job spawned the same task

**Solution:**
- Add duplicate detection logic based on due_date
- Query for existing scheduled instances before spawning

### Problem: Cron Not Firing

**Check:**
1. Has the Worker been deployed?
2. Is the cron syntax valid?
3. Check Cloudflare dashboard for scheduled triggers
4. View logs with `npx wrangler tail`

## Future Enhancements

Potential improvements:
- **Time-of-day spawning**: Spawn at specific times, not just midnight
- **Batch processing**: Create multiple instances ahead of time
- **Smart scheduling**: Consider user's timezone
- **Duplicate prevention**: Check for existing instances before spawning
- **Metrics**: Track spawn success rate, processing time
- **Notifications**: Alert users when new instances are created
- **Grace period**: Allow tasks to be completed within X hours before spawning next

## Security

- All operations respect tenant isolation
- Encryption keys retrieved per-tenant
- No cross-tenant data access
- Logs sanitized (no sensitive data)

## Cost Considerations

Cloudflare Cron Triggers are free with Workers:
- Cron executions count toward CPU time limit
- D1 database queries count toward quota
- KV reads for encryption keys count toward quota

For production:
- Monitor CPU time usage
- Consider optimizing for large datasets
- Use Durable Objects for coordination if needed
