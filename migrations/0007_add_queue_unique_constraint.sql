-- Migration: Add unique constraint to prevent duplicate active queue entries
-- A task should only have one active entry in the queue at a time

-- Create a unique partial index for active queue entries (queued, claimed, dispatched)
-- SQLite supports partial indexes with WHERE clause
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_queue_task_active
ON execution_queue(task_id)
WHERE status IN ('queued', 'claimed', 'dispatched');
