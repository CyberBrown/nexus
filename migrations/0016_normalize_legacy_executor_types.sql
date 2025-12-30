-- Migration: Normalize any remaining legacy executor_type values
--
-- This completes the normalization started in 0011_simplify_executor_types.sql
-- Also handles execution_archive table and tasks table
--
-- OLD types: 'claude-code', 'claude-ai', 'de-agent'
-- NEW type: 'ai'

-- Update tasks table (executor_type column added in 0005)
UPDATE tasks SET executor_type = 'ai' WHERE executor_type IN ('claude-code', 'claude-ai', 'de-agent');

-- Update execution_archive table (in case any legacy entries were archived)
UPDATE execution_archive SET executor_type = 'ai' WHERE executor_type IN ('claude-code', 'claude-ai', 'de-agent');

-- Re-run on execution_queue and dispatch_log in case new entries were added since 0011
UPDATE execution_queue SET executor_type = 'ai' WHERE executor_type IN ('claude-code', 'claude-ai', 'de-agent');
UPDATE dispatch_log SET executor_type = 'ai' WHERE executor_type IN ('claude-code', 'claude-ai', 'de-agent');
