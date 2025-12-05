-- Migration: Add recurring tasks support
-- Description: Adds fields for recurring task functionality
-- Note: The base schema already includes recurrence_rule and recurrence_parent_id
-- This migration documents the recurring tasks feature and adds helpful indexes

-- The tasks table already has these columns:
-- - recurrence_rule TEXT            (RRULE format string)
-- - recurrence_parent_id TEXT       (UUID of parent task for tracking chains)
-- - due_date TEXT                   (Required for recurrence calculations)
-- - status TEXT                     (Used to identify completed tasks)

-- Add index to improve recurring task queries
CREATE INDEX IF NOT EXISTS idx_tasks_recurrence ON tasks(tenant_id, recurrence_rule)
WHERE recurrence_rule IS NOT NULL AND deleted_at IS NULL;

-- Add composite index for scheduled job performance
CREATE INDEX IF NOT EXISTS idx_tasks_due_recurrence ON tasks(tenant_id, due_date, recurrence_rule)
WHERE recurrence_rule IS NOT NULL AND deleted_at IS NULL;

-- Add index for recurrence chain queries
CREATE INDEX IF NOT EXISTS idx_tasks_recurrence_parent ON tasks(tenant_id, recurrence_parent_id)
WHERE recurrence_parent_id IS NOT NULL;

-- Migration notes:
-- 1. These indexes optimize the scheduled job that runs daily
-- 2. The partial indexes (WHERE clauses) reduce index size
-- 3. recurrence_rule and recurrence_parent_id were in the original schema
-- 4. No schema changes needed, only performance optimization
