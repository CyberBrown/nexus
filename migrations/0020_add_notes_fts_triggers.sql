-- Migration: Add FTS5 sync triggers for notes search
--
-- Problem: Multi-word search fails because notes_fts is not kept in sync with notes.search_text
-- The search_text column stores plaintext (decrypted title + content + tags) for FTS indexing.
-- These triggers ensure notes_fts stays synchronized whenever notes are created/updated/deleted.
--
-- Note: The application must still populate search_text when creating/updating notes.
-- These triggers handle syncing search_text TO notes_fts automatically.

-- Drop any existing triggers (clean slate)
DROP TRIGGER IF EXISTS notes_fts_sync_insert;
DROP TRIGGER IF EXISTS notes_fts_sync_update;
DROP TRIGGER IF EXISTS notes_fts_sync_delete;

-- Trigger: Sync search_text to FTS when a note is inserted
-- Only inserts to FTS if search_text is not null/empty and note isn't deleted
CREATE TRIGGER notes_fts_sync_insert AFTER INSERT ON notes
WHEN NEW.deleted_at IS NULL AND NEW.search_text IS NOT NULL AND NEW.search_text != ''
BEGIN
    INSERT OR REPLACE INTO notes_fts (note_id, search_text)
    VALUES (NEW.id, NEW.search_text);
END;

-- Trigger: Sync search_text to FTS when a note is updated
-- Handles both search_text changes and soft deletes
CREATE TRIGGER notes_fts_sync_update AFTER UPDATE ON notes
BEGIN
    -- Remove old FTS entry
    DELETE FROM notes_fts WHERE note_id = OLD.id;

    -- Insert new entry only if not soft-deleted and has search_text
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

-- Rebuild FTS index from existing notes that have search_text populated
-- This ensures all current notes are searchable after migration
DELETE FROM notes_fts;
INSERT INTO notes_fts (note_id, search_text)
SELECT id, search_text
FROM notes
WHERE deleted_at IS NULL
  AND search_text IS NOT NULL
  AND search_text != '';
