-- Migration: Fix FTS5 by populating search_text for all notes
--
-- Problem: Multi-word search returns 0 results because notes are missing search_text.
-- Notes created before migration 0018 don't have search_text populated.
-- Since encryption is disabled (pass-through), we can populate search_text directly from
-- the plaintext title, content, and tags columns.
--
-- This migration:
-- 1. Populates search_text for ALL notes that are missing it
-- 2. Ensures search_text is lowercased (required for FTS5 case-sensitive matching)
-- 3. Rebuilds the FTS5 index with all notes

-- Step 1: Populate search_text for notes missing it
-- Concatenate title + content + tags, trimmed and lowercased
-- Using COALESCE to handle NULL values, LOWER for case-insensitive search
UPDATE notes
SET search_text = LOWER(
    TRIM(
        COALESCE(title, '') || ' ' ||
        COALESCE(content, '') || ' ' ||
        COALESCE(tags, '')
    )
)
WHERE search_text IS NULL OR search_text = '';

-- Step 2: Ensure ALL notes have lowercased search_text
-- (Fixes any notes where search_text wasn't lowercased properly)
UPDATE notes
SET search_text = LOWER(search_text)
WHERE search_text IS NOT NULL
  AND search_text != ''
  AND search_text != LOWER(search_text);

-- Step 3: Rebuild FTS5 index completely
-- Clear all existing entries
DELETE FROM notes_fts;

-- Re-populate from all notes that have search_text
INSERT INTO notes_fts (note_id, search_text)
SELECT id, search_text
FROM notes
WHERE deleted_at IS NULL
  AND search_text IS NOT NULL
  AND search_text != '';
