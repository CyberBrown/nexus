-- Migration: Simplify executor_type from 4 types to 3 types
--
-- OLD types: 'claude-code', 'claude-ai', 'de-agent', 'human'
-- NEW types: 'human', 'human-ai', 'ai'
--
-- Nexus should not care HOW AI tasks are executed - it just hands them to DE.
-- Key principle: Does a human need to be involved?
-- - Yes, fully → human
-- - Yes, partially → human-ai
-- - No → ai (send to DE, done)

-- Update execution_queue table
UPDATE execution_queue SET executor_type = 'ai' WHERE executor_type IN ('claude-code', 'claude-ai', 'de-agent');
-- Note: 'human' stays as 'human'

-- Update dispatch_log table (historical records)
UPDATE dispatch_log SET executor_type = 'ai' WHERE executor_type IN ('claude-code', 'claude-ai', 'de-agent');
-- Note: 'human' stays as 'human'
