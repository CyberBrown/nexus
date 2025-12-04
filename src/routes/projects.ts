import { Hono } from 'hono';
import type { AppType, Project, CreateProjectInput, UpdateProjectInput } from '../types/index.ts';
import { getAuth } from '../lib/auth.ts';
import { findAll, findById, insert, update, softDelete } from '../lib/db.ts';
import { getEncryptionKey, encryptFields, decryptFields } from '../lib/encryption.ts';

const ENCRYPTED_FIELDS = ['name', 'description', 'objective'];

const projects = new Hono<AppType>();

// List projects
projects.get('/', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const status = c.req.query('status');

  try {
    let items = await findAll<Project>(c.env.DB, 'projects', {
      tenantId,
      orderBy: 'created_at DESC',
    });

    // Filter by user
    items = items.filter((item) => item.user_id === userId);

    // Optional status filter
    if (status) {
      items = items.filter((item) => item.status === status);
    }

    // Decrypt sensitive fields
    const key = await getEncryptionKey(c.env.KV, tenantId);
    const decryptedItems = await Promise.all(
      items.map((item) => decryptFields(item, ENCRYPTED_FIELDS, key))
    );

    return c.json({ success: true, data: decryptedItems });
  } catch (error) {
    console.error('Error listing projects:', error);
    return c.json({ success: false, error: 'Failed to list projects' }, 500);
  }
});

// Get single project
projects.get('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  try {
    const item = await findById<Project>(c.env.DB, 'projects', id, { tenantId });

    if (!item || item.user_id !== userId) {
      return c.json({ success: false, error: 'Project not found' }, 404);
    }

    const key = await getEncryptionKey(c.env.KV, tenantId);
    const decrypted = await decryptFields(item, ENCRYPTED_FIELDS, key);

    return c.json({ success: true, data: decrypted });
  } catch (error) {
    console.error('Error getting project:', error);
    return c.json({ success: false, error: 'Failed to get project' }, 500);
  }
});

// Create project
projects.post('/', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json<CreateProjectInput>();
    const key = await getEncryptionKey(c.env.KV, tenantId);

    const id = crypto.randomUUID();

    const project: Partial<Project> = {
      id,
      tenant_id: tenantId,
      user_id: userId,
      name: body.name,
      description: body.description ?? null,
      objective: body.objective ?? null,
      domain: body.domain ?? 'personal',
      area: body.area ?? null,
      tags: body.tags ?? null,
      status: body.status ?? 'planning',
      health: body.health ?? 'on_track',
      target_date: body.target_date ?? null,
      started_at: body.started_at ?? null,
      completed_at: null,
      parent_project_id: body.parent_project_id ?? null,
      external_id: body.external_id ?? null,
      external_source: body.external_source ?? null,
    };

    const encrypted = await encryptFields(project, ENCRYPTED_FIELDS, key);
    await insert(c.env.DB, 'projects', encrypted);

    return c.json({ success: true, data: { id } }, 201);
  } catch (error) {
    console.error('Error creating project:', error);
    return c.json({ success: false, error: 'Failed to create project' }, 500);
  }
});

// Update project
projects.patch('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  try {
    // Verify ownership
    const existing = await findById<Project>(c.env.DB, 'projects', id, { tenantId });
    if (!existing || existing.user_id !== userId) {
      return c.json({ success: false, error: 'Project not found' }, 404);
    }

    const body = await c.req.json<UpdateProjectInput>();

    // Handle project completion
    if (body.status === 'completed' && existing.status !== 'completed') {
      body.completed_at = new Date().toISOString();
    }

    const key = await getEncryptionKey(c.env.KV, tenantId);
    const encrypted = await encryptFields(body, ENCRYPTED_FIELDS, key);

    const updated = await update(c.env.DB, 'projects', id, encrypted, { tenantId });

    if (!updated) {
      return c.json({ success: false, error: 'Failed to update project' }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Error updating project:', error);
    return c.json({ success: false, error: 'Failed to update project' }, 500);
  }
});

// Delete project (soft delete)
projects.delete('/:id', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const id = c.req.param('id');

  try {
    // Verify ownership
    const existing = await findById<Project>(c.env.DB, 'projects', id, { tenantId });
    if (!existing || existing.user_id !== userId) {
      return c.json({ success: false, error: 'Project not found' }, 404);
    }

    const deleted = await softDelete(c.env.DB, 'projects', id, { tenantId });

    if (!deleted) {
      return c.json({ success: false, error: 'Failed to delete project' }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    console.error('Error deleting project:', error);
    return c.json({ success: false, error: 'Failed to delete project' }, 500);
  }
});

export default projects;
