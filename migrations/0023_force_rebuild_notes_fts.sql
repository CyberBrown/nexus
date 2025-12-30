-- Migration: Force rebuild FTS5 index for notes multi-word search
--
-- Problem: Multi-word search like "MCP validation" returns 0 results even though
-- notes contain both terms. This is because:
-- 1. Previous migrations may not have properly populated search_text
-- 2. The FTS5 index may be out of sync with the search_text column
--
-- Solution: Forcefully rebuild everything from scratch
--
-- Note: This migration assumes encryption is DISABLED (pass-through)
-- so title/content are stored as plaintext in the database.

-- Step 1: Drop existing FTS triggers to prevent interference during rebuild
DROP TRIGGER IF EXISTS notes_fts_sync_insert;
DROP TRIGGER IF EXISTS notes_fts_sync_update;
DROP TRIGGER IF EXISTS notes_fts_sync_delete;

-- Step 2: Drop and recreate FTS5 table with correct schema
DROP TABLE IF EXISTS notes_fts;

CREATE VIRTUAL TABLE notes_fts USING fts5(
    note_id UNINDEXED,
    search_text,
    tokenize='porter unicode61'
);

-- Step 3: Repopulate search_text for ALL notes
-- Force update even if search_text already has a value (might be stale/incorrect)
-- Concatenate title + content + tags, lowercased for case-insensitive search
UPDATE notes
SET search_text = LOWER(
    TRIM(
        COALESCE(title, '') || ' ' ||
        COALESCE(content, '') || ' ' ||
        COALESCE(tags, '')
    )
)
WHERE deleted_at IS NULL;

-- Step 4: Populate FTS5 index from search_text
INSERT INTO notes_fts (note_id, search_text)
SELECT id, search_text
FROM notes
WHERE deleted_at IS NULL
  AND search_text IS NOT NULL
  AND search_text != '';

-- Step 5: Recreate triggers for future sync
-- Trigger: Sync search_text to FTS when a note is inserted
CREATE TRIGGER notes_fts_sync_insert AFTER INSERT ON notes
WHEN NEW.deleted_at IS NULL AND NEW.search_text IS NOT NULL AND NEW.search_text != ''
BEGIN
    DELETE FROM notes_fts WHERE note_id = NEW.id;
    INSERT INTO notes_fts (note_id, search_text)
    VALUES (NEW.id, NEW.search_text);
END;

-- Trigger: Sync search_text to FTS when a note is updated
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
