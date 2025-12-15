-- Migration: Add missing planned_at column to idea_executions table
-- This column was in 0003_execution_loop.sql schema but may not have been applied
-- if 0004_add_execution_tables.sql ran first (which created the table without it)

-- Add planned_at column to idea_executions table
ALTER TABLE idea_executions ADD COLUMN planned_at TEXT;
