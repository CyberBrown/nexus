import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppType, Env, ScheduledEvent } from './types/index.ts';
import { authMiddleware, generateDevToken, getAuth } from './lib/auth.ts';
import { generateTenantKey } from './lib/encryption.ts';
import { AppError, ValidationError, isOperationalError } from './lib/errors.ts';
import inboxRoutes from './routes/inbox.ts';
import tasksRoutes from './routes/tasks.ts';
import projectsRoutes from './routes/projects.ts';
import ideasRoutes from './routes/ideas.ts';
import peopleRoutes from './routes/people.ts';
import commitmentsRoutes from './routes/commitments.ts';
import executionRoutes from './routes/execution.ts';
import { createNexusMcpHandler } from './mcp/index.ts';
import { processRecurringTasks } from './scheduled/recurring-tasks.ts';

// Re-export Durable Objects
export { InboxManager } from './durable-objects/InboxManager.ts';
export { CaptureBuffer } from './durable-objects/CaptureBuffer.ts';
export { SyncManager } from './durable-objects/SyncManager.ts';
export { UserSession } from './durable-objects/UserSession.ts';
export { IdeaExecutor } from './durable-objects/IdeaExecutor.ts';

// Re-export Workflows
export { IdeaToPlanWorkflow } from './workflows/IdeaToPlanWorkflow.ts';
export { TaskExecutorWorkflow } from './workflows/TaskExecutorWorkflow.ts';

// Scheduled handler for Cloudflare Cron Triggers
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Cron trigger fired at ${new Date(event.scheduledTime).toISOString()}`);

    // Process recurring tasks
    ctx.waitUntil(processRecurringTasks(env));
  },
};

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

// Debug endpoint to see incoming headers
app.get('/debug/headers', (c) => {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    // Mask sensitive values
    if (key.toLowerCase().includes('secret') || key.toLowerCase().includes('authorization')) {
      headers[key] = value.substring(0, 8) + '...[masked]';
    } else {
      headers[key] = value;
    }
  });
  return c.json({ headers });
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
api.route('/execution', executionRoutes);

// ========================================
// Auth Routes
// ========================================

// Get current user info
api.get('/auth/me', async (c) => {
  const { tenantId, userId, userEmail } = getAuth(c);

  try {
    // Get user details from database
    const user = await c.env.DB.prepare(`
      SELECT id, email, name, role, timezone, created_at
      FROM users
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).bind(userId, tenantId).first();

    if (!user) {
      return c.json({ success: false, error: 'User not found' }, 404);
    }

    // Get tenant info
    const tenant = await c.env.DB.prepare(`
      SELECT id, name, created_at
      FROM tenants
      WHERE id = ? AND deleted_at IS NULL
    `).bind(tenantId).first();

    return c.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email || userEmail,
          name: user.name,
          role: user.role,
          timezone: user.timezone,
          created_at: user.created_at,
        },
        tenant: tenant ? {
          id: tenant.id,
          name: tenant.name,
          created_at: tenant.created_at,
        } : null,
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    return c.json({ success: false, error: 'Failed to get user info' }, 500);
  }
});

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

// ========================================
// CaptureBuffer Durable Object Routes
// ========================================

// Append a chunk to the capture buffer
api.post('/buffer/append', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json();

    // Get the DO instance for this user (one buffer per user)
    const id = c.env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.CAPTURE_BUFFER.get(id);

    // Forward to DO
    const response = await stub.fetch(new Request('http://do/append', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,
        user_id: userId,
        ...body,
      }),
    }));

    return response;
  } catch (error) {
    console.error('Buffer append error:', error);
    return c.json({ success: false, error: 'Buffer append failed' }, 500);
  }
});

// Force flush the buffer
api.post('/buffer/flush', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json().catch(() => ({}));

    const id = c.env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.CAPTURE_BUFFER.get(id);

    const response = await stub.fetch(new Request('http://do/flush', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,
        user_id: userId,
        ...body,
      }),
    }));

    return response;
  } catch (error) {
    console.error('Buffer flush error:', error);
    return c.json({ success: false, error: 'Buffer flush failed' }, 500);
  }
});

// Get buffer status
api.get('/buffer/status', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const id = c.env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.CAPTURE_BUFFER.get(id);

    const response = await stub.fetch(new Request('http://do/status'));
    return response;
  } catch (error) {
    console.error('Buffer status error:', error);
    return c.json({ success: false, error: 'Failed to get buffer status' }, 500);
  }
});

// Get current buffer contents
api.get('/buffer', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const id = c.env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.CAPTURE_BUFFER.get(id);

    const response = await stub.fetch(new Request('http://do/buffer'));
    return response;
  } catch (error) {
    console.error('Buffer get error:', error);
    return c.json({ success: false, error: 'Failed to get buffer' }, 500);
  }
});

// Configure buffer settings
api.post('/buffer/configure', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const config = await c.req.json();

    const id = c.env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.CAPTURE_BUFFER.get(id);

    const response = await stub.fetch(new Request('http://do/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }));

    return response;
  } catch (error) {
    console.error('Buffer configure error:', error);
    return c.json({ success: false, error: 'Failed to configure buffer' }, 500);
  }
});

// Clear buffer
api.post('/buffer/clear', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const id = c.env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.CAPTURE_BUFFER.get(id);

    const response = await stub.fetch(new Request('http://do/clear', {
      method: 'POST',
    }));

    return response;
  } catch (error) {
    console.error('Buffer clear error:', error);
    return c.json({ success: false, error: 'Failed to clear buffer' }, 500);
  }
});

// WebSocket endpoint for real-time buffer updates
api.get('/buffer/ws', async (c) => {
  const { tenantId, userId } = getAuth(c);

  // Check for WebSocket upgrade
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.json({ success: false, error: 'Expected WebSocket upgrade' }, 426);
  }

  try {
    const id = c.env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.CAPTURE_BUFFER.get(id);

    // Forward WebSocket upgrade to DO
    const url = new URL(c.req.url);
    url.searchParams.set('userId', userId);

    return stub.fetch(new Request(url.toString(), {
      headers: c.req.raw.headers,
    }));
  } catch (error) {
    console.error('Buffer WebSocket error:', error);
    return c.json({ success: false, error: 'WebSocket connection failed' }, 500);
  }
});

// ========================================
// UserSession Durable Object Routes
// ========================================

// Get session status
api.get('/session/status', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request('http://do/status'));
    return response;
  } catch (error) {
    console.error('Session status error:', error);
    return c.json({ success: false, error: 'Failed to get session status' }, 500);
  }
});

// Send heartbeat
api.post('/session/heartbeat', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json().catch(() => ({}));

    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request('http://do/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        tenantId,
        ...body,
      }),
    }));

    return response;
  } catch (error) {
    console.error('Heartbeat error:', error);
    return c.json({ success: false, error: 'Heartbeat failed' }, 500);
  }
});

// Get connected devices
api.get('/session/devices', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request('http://do/devices'));
    return response;
  } catch (error) {
    console.error('Get devices error:', error);
    return c.json({ success: false, error: 'Failed to get devices' }, 500);
  }
});

// Register a new device
api.post('/session/device/register', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json();

    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request('http://do/device/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        tenantId,
        ...body,
      }),
    }));

    return response;
  } catch (error) {
    console.error('Register device error:', error);
    return c.json({ success: false, error: 'Failed to register device' }, 500);
  }
});

// Disconnect a device
api.delete('/session/device/:deviceId', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const deviceId = c.req.param('deviceId');

  try {
    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request(`http://do/device/${deviceId}`, {
      method: 'DELETE',
    }));

    return response;
  } catch (error) {
    console.error('Disconnect device error:', error);
    return c.json({ success: false, error: 'Failed to disconnect device' }, 500);
  }
});

// Get user preferences
api.get('/session/preferences', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request('http://do/preferences'));
    return response;
  } catch (error) {
    console.error('Get preferences error:', error);
    return c.json({ success: false, error: 'Failed to get preferences' }, 500);
  }
});

// Update user preferences
api.post('/session/preferences', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json();

    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request('http://do/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

    return response;
  } catch (error) {
    console.error('Update preferences error:', error);
    return c.json({ success: false, error: 'Failed to update preferences' }, 500);
  }
});

// WebSocket endpoint for real-time presence updates
api.get('/session/ws', async (c) => {
  const { tenantId, userId } = getAuth(c);

  // Check for WebSocket upgrade
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.json({ success: false, error: 'Expected WebSocket upgrade' }, 426);
  }

  try {
    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    // Get deviceId from query params
    const url = new URL(c.req.url);
    url.searchParams.set('userId', userId);

    // Forward deviceId if provided
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) {
      return c.json({ success: false, error: 'Missing deviceId parameter' }, 400);
    }

    // Forward WebSocket upgrade to DO
    return stub.fetch(new Request(url.toString(), {
      headers: c.req.raw.headers,
    }));
  } catch (error) {
    console.error('Session WebSocket error:', error);
    return c.json({ success: false, error: 'WebSocket connection failed' }, 500);
  }
});

// ========================================
// UserSession Auth Session Lifecycle Routes
// ========================================

// Create a new auth session
api.post('/session/auth/create', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json();

    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request('http://do/session/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,
        user_id: userId,
        ...body,
      }),
    }));

    return response;
  } catch (error) {
    console.error('Create auth session error:', error);
    return c.json({ success: false, error: 'Failed to create auth session' }, 500);
  }
});

// Refresh an auth session
api.post('/session/auth/refresh', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json();

    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request('http://do/session/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

    return response;
  } catch (error) {
    console.error('Refresh auth session error:', error);
    return c.json({ success: false, error: 'Failed to refresh auth session' }, 500);
  }
});

// Validate an auth session
api.get('/session/auth/validate', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const sessionId = c.req.query('session_id');

    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const url = new URL('http://do/session/validate');
    if (sessionId) {
      url.searchParams.set('session_id', sessionId);
    }

    const response = await stub.fetch(new Request(url.toString()));
    return response;
  } catch (error) {
    console.error('Validate auth session error:', error);
    return c.json({ success: false, error: 'Failed to validate auth session' }, 500);
  }
});

// Revoke an auth session
api.post('/session/auth/revoke', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json();

    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request('http://do/session/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

    return response;
  } catch (error) {
    console.error('Revoke auth session error:', error);
    return c.json({ success: false, error: 'Failed to revoke auth session' }, 500);
  }
});

// Revoke all auth sessions
api.post('/session/auth/revoke-all', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json().catch(() => ({}));

    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request('http://do/session/revoke-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));

    return response;
  } catch (error) {
    console.error('Revoke all auth sessions error:', error);
    return c.json({ success: false, error: 'Failed to revoke all auth sessions' }, 500);
  }
});

// List all auth sessions
api.get('/session/auth/list', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request('http://do/session/list'));
    return response;
  } catch (error) {
    console.error('List auth sessions error:', error);
    return c.json({ success: false, error: 'Failed to list auth sessions' }, 500);
  }
});

// Delete an auth session
api.delete('/session/auth/:sessionId', async (c) => {
  const { tenantId, userId } = getAuth(c);
  const sessionId = c.req.param('sessionId');

  try {
    const id = c.env.USER_SESSION.idFromName(`${tenantId}:${userId}`);
    const stub = c.env.USER_SESSION.get(id);

    const response = await stub.fetch(new Request(`http://do/session/${sessionId}`, {
      method: 'DELETE',
    }));

    return response;
  } catch (error) {
    console.error('Delete auth session error:', error);
    return c.json({ success: false, error: 'Failed to delete auth session' }, 500);
  }
});

// ========================================
// SyncManager Durable Object Routes
// ========================================

// Push changes to sync manager (device -> server)
api.post('/sync/push', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json();

    // Get the DO instance for this tenant
    const id = c.env.SYNC_MANAGER.idFromName(tenantId);
    const stub = c.env.SYNC_MANAGER.get(id);

    // Forward to DO
    const response = await stub.fetch(new Request('http://do/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,
        user_id: userId,
        push: body,
      }),
    }));

    return response;
  } catch (error) {
    console.error('Sync push error:', error);
    return c.json({ success: false, error: 'Sync push failed' }, 500);
  }
});

// Pull changes from sync manager (server -> device)
api.post('/sync/pull', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json();

    const id = c.env.SYNC_MANAGER.idFromName(tenantId);
    const stub = c.env.SYNC_MANAGER.get(id);

    const response = await stub.fetch(new Request('http://do/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenantId,
        user_id: userId,
        pull: body,
      }),
    }));

    return response;
  } catch (error) {
    console.error('Sync pull error:', error);
    return c.json({ success: false, error: 'Sync pull failed' }, 500);
  }
});

// Get sync status
api.get('/sync/status', async (c) => {
  const { tenantId } = getAuth(c);

  try {
    const id = c.env.SYNC_MANAGER.idFromName(tenantId);
    const stub = c.env.SYNC_MANAGER.get(id);

    const response = await stub.fetch(new Request('http://do/status'));
    return response;
  } catch (error) {
    console.error('Sync status error:', error);
    return c.json({ success: false, error: 'Failed to get sync status' }, 500);
  }
});

// Get pending changes for a device
api.get('/sync/pending', async (c) => {
  const { tenantId } = getAuth(c);

  try {
    const deviceId = c.req.query('deviceId');
    if (!deviceId) {
      return c.json({ success: false, error: 'Missing deviceId parameter' }, 400);
    }

    const id = c.env.SYNC_MANAGER.idFromName(tenantId);
    const stub = c.env.SYNC_MANAGER.get(id);

    const url = new URL('http://do/pending');
    url.searchParams.set('deviceId', deviceId);

    const response = await stub.fetch(new Request(url.toString()));
    return response;
  } catch (error) {
    console.error('Sync pending error:', error);
    return c.json({ success: false, error: 'Failed to get pending changes' }, 500);
  }
});

// WebSocket endpoint for real-time sync notifications
api.get('/sync/ws', async (c) => {
  const { tenantId, userId } = getAuth(c);

  // Check for WebSocket upgrade
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return c.json({ success: false, error: 'Expected WebSocket upgrade' }, 426);
  }

  try {
    const deviceId = c.req.query('deviceId');
    if (!deviceId) {
      return c.json({ success: false, error: 'Missing deviceId parameter' }, 400);
    }

    const id = c.env.SYNC_MANAGER.idFromName(tenantId);
    const stub = c.env.SYNC_MANAGER.get(id);

    // Forward WebSocket upgrade to DO
    const url = new URL(c.req.url);
    url.searchParams.set('userId', userId);
    url.searchParams.set('deviceId', deviceId);

    return stub.fetch(new Request(url.toString(), {
      headers: c.req.raw.headers,
    }));
  } catch (error) {
    console.error('Sync WebSocket error:', error);
    return c.json({ success: false, error: 'Sync WebSocket connection failed' }, 500);
  }
});

app.route('/api', api);

// ========================================
// MCP Server Endpoint (root level for mcp-remote compatibility)
// ========================================
app.all('/mcp', authMiddleware(), async (c) => {
  const { tenantId, userId } = getAuth(c);
  const handler = createNexusMcpHandler(c.env, tenantId, userId);
  return handler(c.req.raw, c.env, c.executionCtx);
});

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
