-- Migration: Add notes table for persistent note storage
-- Part of the Nexus Notes feature (Idea: f7ad9058-7f0d-4faa-9d15-97df350cd9a7)

CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    user_id TEXT NOT NULL REFERENCES users(id),

    -- Core content (encrypted)
    title TEXT NOT NULL, -- encrypted
    content TEXT, -- encrypted

    -- Categorization
    category TEXT DEFAULT 'general', -- general, meeting, research, reference, idea, log
    tags TEXT, -- JSON array of tags

    -- Source tracking - where did this note originate?
    source_type TEXT, -- claude_conversation, idea_execution, task, manual, capture
    source_reference TEXT, -- ID or URL of the source
    source_context TEXT, -- Additional context about the source (e.g., conversation snippet)

    -- Organization
    pinned INTEGER DEFAULT 0, -- 1 = pinned to top
    archived_at TEXT, -- When archived, NULL if active

    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT -- Soft delete
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_notes_tenant ON notes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(tenant_id, user_id, category);
CREATE INDEX IF NOT EXISTS idx_notes_source ON notes(tenant_id, source_type, source_reference);
CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(tenant_id, user_id, pinned);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(tenant_id, user_id, created_at DESC);
