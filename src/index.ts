import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppType } from './types/index.ts';
import { authMiddleware, generateDevToken, getAuth } from './lib/auth.ts';
import { generateTenantKey } from './lib/encryption.ts';
import { AppError, ValidationError, isOperationalError } from './lib/errors.ts';
import inboxRoutes from './routes/inbox.ts';
import tasksRoutes from './routes/tasks.ts';
import projectsRoutes from './routes/projects.ts';
import ideasRoutes from './routes/ideas.ts';
import peopleRoutes from './routes/people.ts';
import commitmentsRoutes from './routes/commitments.ts';

// Re-export Durable Object
export { InboxManager } from './durable-objects/InboxManager.ts';

const app = new Hono<AppType>();

// Global middleware
app.use('*', logger());
app.use('*', cors());

// Health check
app.get('/', (c) => {
  return c.json({
    name: 'Nexus API',
    version: '0.1.0',
    status: 'healthy',
  });
});

// Dev-only: Setup endpoint to create initial tenant and user
app.post('/setup', async (c) => {
  if (c.env.ENVIRONMENT !== 'development') {
    return c.json({ success: false, error: 'Setup only available in development' }, 403);
  }

  try {
    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Create tenant
    await c.env.DB.prepare(`
      INSERT INTO tenants (id, name, encryption_key_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(tenantId, 'Default Tenant', `tenant:${tenantId}:key`, now, now).run();

    // Create user
    await c.env.DB.prepare(`
      INSERT INTO users (id, tenant_id, email, name, role, timezone, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(userId, tenantId, 'user@example.com', 'Default User', 'owner', 'UTC', now, now).run();

    // Generate encryption key for tenant
    await generateTenantKey(c.env.KV, tenantId);

    // Generate a dev token
    const token = generateDevToken(tenantId, userId);

    return c.json({
      success: true,
      data: {
        tenant_id: tenantId,
        user_id: userId,
        token,
        message: 'Use this token in Authorization header: Bearer <token>',
      },
    });
  } catch (error) {
    console.error('Setup error:', error);
    return c.json({ success: false, error: 'Setup failed' }, 500);
  }
});

// API routes (protected)
const api = new Hono<AppType>();
api.use('*', authMiddleware());

// CRUD routes
api.route('/inbox', inboxRoutes);
api.route('/tasks', tasksRoutes);
api.route('/projects', projectsRoutes);
api.route('/ideas', ideasRoutes);
api.route('/people', peopleRoutes);
api.route('/commitments', commitmentsRoutes);

// ========================================
// InboxManager Durable Object Routes
// ========================================

// Capture a single item (voice, email, webhook, etc.)
api.post('/capture', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json();

    // Get the DO instance for this tenant
    const id = c.env.INBOX_MANAGER.idFromName(tenantId);
    const stub = c.env.INBOX_MANAGER.get(id);

    // Forward to DO
    const response = await stub.fetch(new Request('http://do/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,
        user_id: userId,
        input: body,
      }),
    }));

    return response;
  } catch (error) {
    console.error('Capture error:', error);
    return c.json({ success: false, error: 'Capture failed' }, 500);
  }
});

// Batch capture multiple items
api.post('/capture/batch', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json();

    const id = c.env.INBOX_MANAGER.idFromName(tenantId);
    const stub = c.env.INBOX_MANAGER.get(id);

    const response = await stub.fetch(new Request('http://do/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,
        user_id: userId,
        inputs: body.inputs,
      }),
    }));

    return response;
  } catch (error) {
    console.error('Batch capture error:', error);
    return c.json({ success: false, error: 'Batch capture failed' }, 500);
  }
});

// Get InboxManager status
api.get('/capture/status', async (c) => {
  const { tenantId } = getAuth(c);

  try {
    const id = c.env.INBOX_MANAGER.idFromName(tenantId);
    const stub = c.env.INBOX_MANAGER.get(id);

    const response = await stub.fetch(new Request('http://do/status'));
    return response;
  } catch (error) {
    console.error('Status error:', error);
    return c.json({ success: false, error: 'Failed to get status' }, 500);
  }
});

// Get classification queue status
api.get('/capture/queue', async (c) => {
  const { tenantId } = getAuth(c);

  try {
    const id = c.env.INBOX_MANAGER.idFromName(tenantId);
    const stub = c.env.INBOX_MANAGER.get(id);

    const response = await stub.fetch(new Request('http://do/queue'));
    return response;
  } catch (error) {
    console.error('Queue error:', error);
    return c.json({ success: false, error: 'Failed to get queue' }, 500);
  }
});

// WebSocket endpoint for real-time updates
api.get('/capture/ws', async (c) => {
  const { tenantId, userId } = getAuth(c);

  // Check for WebSocket upgrade
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.json({ success: false, error: 'Expected WebSocket upgrade' }, 426);
  }

  try {
    const id = c.env.INBOX_MANAGER.idFromName(tenantId);
    const stub = c.env.INBOX_MANAGER.get(id);

    // Forward WebSocket upgrade to DO
    const url = new URL(c.req.url);
    url.searchParams.set('userId', userId);

    return stub.fetch(new Request(url.toString(), {
      headers: c.req.raw.headers,
    }));
  } catch (error) {
    console.error('WebSocket error:', error);
    return c.json({ success: false, error: 'WebSocket connection failed' }, 500);
  }
});

app.route('/api', api);

// 404 handler
app.notFound((c) => {
  return c.json({ success: false, error: 'Not found' }, 404);
});

// Global error handler
app.onError((err, c) => {
  // Handle validation errors
  if (err instanceof ValidationError) {
    return c.json(err.toJSON(), err.statusCode);
  }

  // Handle known operational errors
  if (isOperationalError(err)) {
    return c.json(err.toJSON(), err.statusCode);
  }

  // Log unexpected errors
  console.error('Unhandled error:', err);

  // Don't expose internal error details in production
  const message = c.env.ENVIRONMENT === 'development'
    ? err.message
    : 'Internal server error';

  return c.json({
    success: false,
    error: { message, code: 'INTERNAL_ERROR' },
  }, 500);
});

export default app;
