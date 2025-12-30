import { Hono } from 'hono';
import type { AppType, Note } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';
import { validate, createNoteSchema, updateNoteSchema } from '../lib/validation.ts';
import { NotFoundError } from '../lib/errors.ts';

const ENCRYPTED_FIELDS = ['title', 'content'];

const notes = new Hono<AppType>();

// List notes
notes.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const category = c.req.query('category');
  const archived = c.req.query('archived');
  const pinned = c.req.query('pinned');
  const search = c.req.query('search');
  const source_type = c.req.query('source_type');

  let items: Note[];

  // If search query is provided, use FTS5
  if (search && search.trim()) {
    try {
      // Ensure FTS5 table exists with correct schema before searching
      // This fixes schema mismatch if old migration (0017) was applied
      let ftsTableCreatedEmpty = false;
      try {
        const tableInfo = await c.env.DB.prepare(
          `SELECT name FROM pragma_table_info('notes_fts') WHERE name = 'note_id'`
        ).first<{ name: string } | null>();

        if (!tableInfo) {
          // Table either doesn't exist or has old schema - drop and recreate
          await c.env.DB.prepare(`DROP TABLE IF EXISTS notes_fts`).run();
          await c.env.DB.prepare(`
            CREATE VIRTUAL TABLE notes_fts USING fts5(
              note_id UNINDEXED,
              search_text,
              tokenize='porter unicode61'
            )
          `).run();
          ftsTableCreatedEmpty = true;
        } else {
          // Check if FTS table has entries for this user
          const ftsCount = await c.env.DB.prepare(`
            SELECT COUNT(*) as cnt FROM notes_fts
            WHERE note_id IN (SELECT id FROM notes WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL)
          `).bind(tenantId, userId).first<{ cnt: number }>();

          if (!ftsCount || ftsCount.cnt === 0) {
            // FTS table exists but is empty - need to populate
            ftsTableCreatedEmpty = true;
          }
        }

        // Auto-populate FTS index - always check for missing entries, not just when empty
        // This handles the case where some notes exist in FTS but others are missing
        const notesWithSearchText = await c.env.DB.prepare(`
          SELECT n.id, n.search_text FROM notes n
          LEFT JOIN notes_fts f ON n.id = f.note_id
          WHERE n.tenant_id = ? AND n.user_id = ? AND n.deleted_at IS NULL
            AND n.search_text IS NOT NULL AND n.search_text != ''
            AND f.note_id IS NULL
        `).bind(tenantId, userId).all<{ id: string; search_text: string }>();

        if (notesWithSearchText.results && notesWithSearchText.results.length > 0) {
          // Batch populate FTS index for missing entries
          for (const note of notesWithSearchText.results) {
            try {
              await c.env.DB.prepare(`INSERT INTO notes_fts (note_id, search_text) VALUES (?, ?)`)
                .bind(note.id, note.search_text).run();
            } catch {
              // Ignore duplicates
            }
          }
        }

        // Also handle notes WITHOUT search_text - need to decrypt and populate
        const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
        const notesWithoutSearchText = await c.env.DB.prepare(`
          SELECT n.id, n.title, n.content, n.tags FROM notes n
          LEFT JOIN notes_fts f ON n.id = f.note_id
          WHERE n.tenant_id = ? AND n.user_id = ? AND n.deleted_at IS NULL
            AND (n.search_text IS NULL OR n.search_text = '')
            AND f.note_id IS NULL
        `).bind(tenantId, userId).all<{ id: string; title: string | null; content: string | null; tags: string | null }>();

        if (notesWithoutSearchText.results && notesWithoutSearchText.results.length > 0) {
          // Decrypt and populate FTS index for notes missing search_text
          for (const note of notesWithoutSearchText.results) {
            try {
              // Try to decrypt - if it fails, use raw value (for non-encrypted notes)
              let decryptedTitle = '';
              let decryptedContent = '';
              try {
                const { decryptField } = await import('../lib/encryption.ts');
                decryptedTitle = note.title ? await decryptField(note.title, encryptionKey) : '';
                decryptedContent = note.content ? await decryptField(note.content, encryptionKey) : '';
              } catch {
                // Decryption failed - use raw values
                decryptedTitle = note.title || '';
                decryptedContent = note.content || '';
              }
              const tagsText = note.tags ? String(note.tags) : '';

              // Build search_text (lowercase for FTS case sensitivity)
              const searchText = `${decryptedTitle} ${decryptedContent} ${tagsText}`.trim().toLowerCase();

              if (searchText) {
                // Update notes table with search_text
                await c.env.DB.prepare(`UPDATE notes SET search_text = ? WHERE id = ?`)
                  .bind(searchText, note.id).run();

                // Insert into FTS index
                await c.env.DB.prepare(`INSERT INTO notes_fts (note_id, search_text) VALUES (?, ?)`)
                  .bind(note.id, searchText).run();
              }
            } catch {
              // Ignore errors for individual notes
            }
          }
        }
      } catch {
        // Table check/creation failed, will fall back to in-memory search
      }

      // Convert search query to FTS5 format
      // FTS5 uses implicit AND when terms are space-separated
      // NOTE: Do NOT use prefix matching (word*) with porter stemmer!
      // Prefix queries use raw (pre-tokenized) form, so "validation*" won't match
      // the stemmed "valid" in the index. Let FTS5 handle stemming naturally.
      const ftsTerms: string[] = [];
      const trimmedSearch = search.trim();

      // Extract quoted phrases first, then handle remaining words
      const phraseRegex = /"([^"]+)"/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = phraseRegex.exec(trimmedSearch)) !== null) {
        // Handle any words before this quoted phrase
        const before = trimmedSearch.slice(lastIndex, match.index).trim();
        if (before) {
          for (const word of before.split(/\s+/).filter((w: string) => w.length > 0)) {
            // Escape special FTS5 characters, no prefix matching
            // MUST lowercase because porter tokenizer normalizes to lowercase
            const escaped = word.replace(/[*^"():]/g, '').toLowerCase();
            if (escaped.length > 0) {
              ftsTerms.push(escaped);
            }
          }
        }
        // Add the quoted phrase (exact match)
        const phrase = match[1]!.trim();
        if (phrase.length > 0) {
          // Escape any quotes within the phrase and lowercase for porter tokenizer
          const escapedPhrase = phrase.replace(/"/g, '').toLowerCase();
          ftsTerms.push(`"${escapedPhrase}"`);
        }
        lastIndex = match.index + match[0].length;
      }

      // Handle any remaining words after the last quoted phrase
      const remaining = trimmedSearch.slice(lastIndex).trim();
      if (remaining) {
        for (const word of remaining.split(/\s+/).filter((w: string) => w.length > 0)) {
          // Escape special FTS5 characters, no prefix matching
          // MUST lowercase because porter tokenizer normalizes to lowercase
          const escaped = word.replace(/[*^"():]/g, '').toLowerCase();
          if (escaped.length > 0) {
            ftsTerms.push(escaped);
          }
        }
      }

      // FTS5 column filter syntax: "column:(terms)" - NO spaces around colon
      // Terms are implicitly ANDed when space-separated
      const ftsQuery = ftsTerms.length > 0 ? `search_text:(${ftsTerms.join(' ')})` : '';

      if (ftsQuery) {
        // Build conditions
        const conditions: string[] = [];
        const bindings: (string | number)[] = [ftsQuery, tenantId, userId];

        if (category) {
          conditions.push('n.category = ?');
          bindings.push(category);
        }
        if (archived === 'true') {
          conditions.push('n.archived_at IS NOT NULL');
        } else if (archived === 'false' || !archived) {
          conditions.push('n.archived_at IS NULL');
        }
        if (pinned === 'true') {
          conditions.push('n.pinned = 1');
        }
        if (source_type) {
          conditions.push('n.source_type = ?');
          bindings.push(source_type);
        }

        const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

        // Note: FTS5 MATCH uses the table name directly, not an alias
        const result = await c.env.DB.prepare(`
          SELECT n.*
          FROM notes n
          INNER JOIN notes_fts ON n.id = notes_fts.note_id
          WHERE notes_fts MATCH ?
            AND n.tenant_id = ?
            AND n.user_id = ?
            AND n.deleted_at IS NULL
            ${whereClause}
          ORDER BY n.pinned DESC, bm25(notes_fts) ASC, n.created_at DESC
        `).bind(...bindings).all<Note>();

        items = result.results;
      } else {
        items = [];
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Fallback to in-memory search if FTS5 not available
      if (errorMessage.includes('no such table') || errorMessage.includes('notes_fts')) {
        items = await findAll<Note>(c.env.DB, 'notes', {
          tenantId,
          orderBy: 'pinned DESC, created_at DESC',
        });
        items = items.filter((item) => item.user_id === userId);

        // Apply filters
        if (category) {
          items = items.filter((item) => item.category === category);
        }
        if (archived === 'true') {
          items = items.filter((item) => item.archived_at !== null);
        } else if (archived === 'false' || !archived) {
          items = items.filter((item) => item.archived_at === null);
        }
        if (pinned === 'true') {
          items = items.filter((item) => item.pinned === 1);
        }
        if (source_type) {
          items = items.filter((item) => item.source_type === source_type);
        }

        // In-memory search
        const searchTerms: string[] = [];
        const quotedRegex = /"([^"]+)"/g;
        let match: RegExpExecArray | null;
        let queryWithoutQuotes = search;

        while ((match = quotedRegex.exec(search)) !== null) {
          searchTerms.push(match[1]!.toLowerCase().trim());
        }
        queryWithoutQuotes = search.replace(quotedRegex, '').trim();

        const words = queryWithoutQuotes.split(/\s+/).filter((w: string) => w.length > 0);
        for (const word of words) {
          searchTerms.push(word.toLowerCase().trim());
        }

        if (searchTerms.length > 0) {
          // Get encryption key for decrypting content when search_text is NULL
          const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);

          // Filter items - need to handle both search_text column and encrypted content
          const filteredItems: Note[] = [];
          for (const item of items) {
            let searchableText: string;

            if ((item as any).search_text) {
              // Use plaintext search_text column
              searchableText = String((item as any).search_text).toLowerCase();
            } else {
              // search_text is NULL - try raw values first (encryption is now disabled)
              const rawTitle = item.title ? String(item.title) : '';
              const rawContent = item.content ? String(item.content) : '';
              const tagsText = item.tags ? String(item.tags) : '';

              // First, try matching against raw values (for notes created after encryption was disabled)
              searchableText = `${rawTitle} ${rawContent} ${tagsText}`.toLowerCase();
              if (!searchTerms.every((term) => searchableText.includes(term))) {
                // If raw values don't match, try decryption (for older encrypted notes)
                const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, encryptionKey);
                searchableText = `${decrypted.title || ''} ${decrypted.content || ''} ${tagsText}`.toLowerCase();
              }
            }

            if (searchTerms.every((term) => searchableText.includes(term))) {
              filteredItems.push(item);
            }
          }
          items = filteredItems;
        }
      } else {
        throw error;
      }
    }
  } else {
    // No search query - fetch all with filters
    items = await findAll<Note>(c.env.DB, 'notes', {
      tenantId,
      orderBy: 'pinned DESC, created_at DESC',
    });

    // Filter by user
    items = items.filter((item) => item.user_id === userId);

    // Optional filters
    if (category) {
      items = items.filter((item) => item.category === category);
    }
    if (archived === 'true') {
      items = items.filter((item) => item.archived_at !== null);
    } else if (archived === 'false' || !archived) {
      // Default: exclude archived
      items = items.filter((item) => item.archived_at === null);
    }
    if (pinned === 'true') {
      items = items.filter((item) => item.pinned === 1);
    }
    if (source_type) {
      items = items.filter((item) => item.source_type === source_type);
    }
  }

  // Decrypt sensitive fields (pass-through when encryption is disabled)
  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decryptedItems = await Promise.all(
    items.map((item) => decryptFields(item, ENCRYPTED_FIELDS, key))
  );

  return c.json({ success: true, data: decryptedItems });
});

// Get single note
notes.get('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const item = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!item || item.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, key);

  return c.json({ success: true, data: decrypted });
});

// Create note
notes.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);

  const body = await c.req.json();
  const validated = validate(createNoteSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);
  const id = crypto.randomUUID();

  // Build plaintext search_text for FTS indexing
  // MUST lowercase because D1's FTS5 is case-sensitive and query terms are lowercased
  const searchText = [validated.title, validated.content || '', validated.tags || ''].join(' ').trim().toLowerCase();

  const note: Partial<Note> & { search_text?: string } = {
    id,
    tenant_id: tenantId,
    user_id: userId,
    title: validated.title,
    content: validated.content ?? null,
    category: validated.category ?? 'general',
    tags: validated.tags ?? null,
    source_type: validated.source_type ?? null,
    source_reference: validated.source_reference ?? null,
    source_context: validated.source_context ?? null,
    pinned: validated.pinned ? 1 : 0,
    archived_at: null,
    search_text: searchText,
  };

  const encrypted = await encryptFields(note, ENCRYPTED_FIELDS, key);
  await insert(c.env.DB, 'notes', encrypted);

  // Insert into FTS5 index for full-text search
  try {
    await c.env.DB.prepare(`
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        note_id UNINDEXED,
        search_text,
        tokenize='porter unicode61'
      )
    `).run();
    await c.env.DB.prepare(`INSERT INTO notes_fts (note_id, search_text) VALUES (?, ?)`).bind(id, searchText).run();
  } catch {
    // FTS insert is non-critical
  }

  return c.json({ success: true, data: { id } }, 201);
});

// Update note
notes.patch('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  const body = await c.req.json();
  const validated = validate(updateNoteSchema, body);

  const key = await getEncryptionKey(c.env.KV, tenantId);

  const updates: Partial<Note> & { search_text?: string } = {};

  if (validated.title !== undefined) updates.title = validated.title;
  if (validated.content !== undefined) updates.content = validated.content;
  if (validated.category !== undefined) updates.category = validated.category;
  if (validated.tags !== undefined) updates.tags = validated.tags;
  if (validated.source_type !== undefined) updates.source_type = validated.source_type;
  if (validated.source_reference !== undefined) updates.source_reference = validated.source_reference;
  if (validated.source_context !== undefined) updates.source_context = validated.source_context;
  if (validated.pinned !== undefined) updates.pinned = validated.pinned ? 1 : 0;
  if (validated.archived_at !== undefined) updates.archived_at = validated.archived_at;

  // If title, content, or tags changed, rebuild search_text and update FTS
  if (validated.title !== undefined || validated.content !== undefined || validated.tags !== undefined) {
    const { decryptField } = await import('../lib/encryption.ts');

    // Get current plaintext values for fields not being updated
    const plaintextTitle = validated.title !== undefined
      ? validated.title
      : await decryptField(existing.title, key);
    const plaintextContent = validated.content !== undefined
      ? validated.content
      : (existing.content ? await decryptField(existing.content, key) : null);
    const plaintextTags = validated.tags !== undefined
      ? validated.tags
      : existing.tags;

    // MUST lowercase because D1's FTS5 is case-sensitive and query terms are lowercased
    const searchText = [plaintextTitle || '', plaintextContent || '', plaintextTags || ''].join(' ').trim().toLowerCase();
    updates.search_text = searchText;

    // Update FTS index
    try {
      await c.env.DB.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          note_id UNINDEXED,
          search_text,
          tokenize='porter unicode61'
        )
      `).run();
      await c.env.DB.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).bind(id).run();
      await c.env.DB.prepare(`INSERT INTO notes_fts (note_id, search_text) VALUES (?, ?)`).bind(id, searchText).run();
    } catch {
      // FTS update is non-critical
    }
  }

  if (Object.keys(updates).length > 0) {
    const encrypted = await encryptFields(updates, ENCRYPTED_FIELDS, key);
    await update(c.env.DB, 'notes', id, encrypted, { tenantId });
  }

  return c.json({ success: true, data: { id } });
});

// Delete note (soft delete)
notes.delete('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  await softDelete(c.env.DB, 'notes', id, { tenantId });

  // Remove from FTS index on delete
  await c.env.DB.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).bind(id).run();

  return c.json({ success: true, data: { id } });
});

// Archive note
notes.post('/:id/archive', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  await update(c.env.DB, 'notes', id, { archived_at: new Date().toISOString() }, { tenantId });

  return c.json({ success: true, data: { id, archived: true } });
});

// Unarchive note
notes.post('/:id/unarchive', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  await update(c.env.DB, 'notes', id, { archived_at: null }, { tenantId });

  return c.json({ success: true, data: { id, archived: false } });
});

// Pin/unpin note
notes.post('/:id/pin', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  const existing = await findById<Note>(c.env.DB, 'notes', id, { tenantId });

  if (!existing || existing.user_id !== userId) {
    throw new NotFoundError('Note', id);
  }

  const newPinned = existing.pinned === 1 ? 0 : 1;
  await update(c.env.DB, 'notes', id, { pinned: newPinned }, { tenantId });

  return c.json({ success: true, data: { id, pinned: newPinned === 1 } });
});

export default notes;
