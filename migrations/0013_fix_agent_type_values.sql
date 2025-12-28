-- Migration: Fix agent_type values from 'claude' to 'ai'
-- Updates existing data to use correct agent_type values

-- Update any existing rows with 'claude' agent_type to 'ai'
UPDATE idea_tasks SET agent_type = 'ai' WHERE agent_type = 'claude';

-- Update any existing rows with 'local' agent_type to 'ai' (legacy value)
UPDATE idea_tasks SET agent_type = 'ai' WHERE agent_type = 'local';
