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
      // Convert search query to FTS5 format
      const ftsQuery = search
        .trim()
        .split(/\s+/)
        .filter((term: string) => term.length > 0)
        .map((term: string) => {
          if (term.startsWith('"') || term.endsWith('"')) {
            return term;
          }
          const escaped = term.replace(/[*^]/g, '');
          return escaped.length > 0 ? `"${escaped}"*` : '';
        })
        .filter((term: string) => term.length > 0)
        .join(' ');

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

        const result = await c.env.DB.prepare(`
          SELECT n.*
          FROM notes n
          INNER JOIN notes_fts fts ON n.id = fts.note_id
          WHERE fts.notes_fts MATCH ?
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
          items = items.filter((item) => {
            const tagsText = item.tags ? String(item.tags).toLowerCase() : '';
            const searchableText = `${item.title || ''} ${item.content || ''} ${tagsText}`.toLowerCase();
            return searchTerms.every((term) => searchableText.includes(term));
          });
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
  const searchText = [validated.title, validated.content || '', validated.tags || ''].join(' ').trim();

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
  await c.env.DB.prepare(`INSERT INTO notes_fts (note_id, search_text) VALUES (?, ?)`).bind(id, searchText).run();

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

    const searchText = [plaintextTitle || '', plaintextContent || '', plaintextTags || ''].join(' ').trim();
    updates.search_text = searchText;

    // Update FTS index
    await c.env.DB.prepare(`DELETE FROM notes_fts WHERE note_id = ?`).bind(id).run();
    await c.env.DB.prepare(`INSERT INTO notes_fts (note_id, search_text) VALUES (?, ?)`).bind(id, searchText).run();
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
