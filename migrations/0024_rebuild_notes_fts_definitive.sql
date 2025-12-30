-- Migration: Definitive FTS5 rebuild for notes multi-word search
--
-- This migration is IDEMPOTENT - safe to run multiple times.
-- It fixes the multi-word search issue (e.g., "MCP validation") by:
-- 1. Dropping and recreating the FTS5 virtual table with correct schema
-- 2. Populating search_text from plaintext title/content/tags
-- 3. Populating the FTS5 index from search_text
-- 4. Creating triggers to keep FTS index in sync
--
-- Since encryption is disabled, title and content are stored as plaintext.
--
-- NOTE: The search_text column must already exist (added in migration 0018).
-- If it doesn't exist, run this first:
--   ALTER TABLE notes ADD COLUMN search_text TEXT;

-- Step 1: Drop existing FTS triggers (clean slate)
DROP TRIGGER IF EXISTS notes_fts_sync_insert;
DROP TRIGGER IF EXISTS notes_fts_sync_update;
DROP TRIGGER IF EXISTS notes_fts_sync_delete;

-- Step 3: Drop and recreate FTS5 table with correct schema
-- This ensures we start fresh with the right structure
DROP TABLE IF EXISTS notes_fts;

CREATE VIRTUAL TABLE notes_fts USING fts5(
    note_id UNINDEXED,
    search_text,
    tokenize='porter unicode61'
);

-- Step 4: Populate search_text for ALL non-deleted notes
-- Concatenate title + content + tags, lowercased for case-insensitive search
-- This overwrites any existing search_text to ensure consistency
UPDATE notes
SET search_text = LOWER(
    TRIM(
        COALESCE(title, '') || ' ' ||
        COALESCE(content, '') || ' ' ||
        COALESCE(tags, '')
    )
)
WHERE deleted_at IS NULL;

-- Step 5: Populate FTS5 index from search_text
-- Only index notes that have non-empty search_text
INSERT INTO notes_fts (note_id, search_text)
SELECT id, search_text
FROM notes
WHERE deleted_at IS NULL
  AND search_text IS NOT NULL
  AND search_text != ''
  AND TRIM(search_text) != '';

-- Step 6: Create triggers to keep FTS index in sync with notes table
-- These triggers fire when notes are created, updated, or deleted

-- Trigger: Sync to FTS when a note is inserted
CREATE TRIGGER notes_fts_sync_insert AFTER INSERT ON notes
WHEN NEW.deleted_at IS NULL AND NEW.search_text IS NOT NULL AND NEW.search_text != ''
BEGIN
    DELETE FROM notes_fts WHERE note_id = NEW.id;
    INSERT INTO notes_fts (note_id, search_text)
    VALUES (NEW.id, NEW.search_text);
END;

-- Trigger: Sync to FTS when a note is updated
CREATE TRIGGER notes_fts_sync_update AFTER UPDATE ON notes
BEGIN
    DELETE FROM notes_fts WHERE note_id = OLD.id;
    INSERT INTO notes_fts (note_id, search_text)
    SELECT NEW.id, NEW.search_text
    WHERE NEW.deleted_at IS NULL
      AND NEW.search_text IS NOT NULL
      AND NEW.search_text != '';
END;

-- Trigger: Remove from FTS when a note is hard deleted
CREATE TRIGGER notes_fts_sync_delete AFTER DELETE ON notes
BEGIN
    DELETE FROM notes_fts WHERE note_id = OLD.id;
END;
