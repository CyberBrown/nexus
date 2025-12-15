import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppType, Env, ScheduledEvent } from './types/index.ts';
import { authMiddleware, generateDevToken, getAuth, lookupTenantByPassphrase, registerPassphraseTenant, hashPassphrase } from './lib/auth.ts';
import { generateTenantKey } from './lib/encryption.ts';
import { AppError, ValidationError, isOperationalError } from './lib/errors.ts';
import inboxRoutes from './routes/inbox.ts';
import tasksRoutes from './routes/tasks.ts';
import projectsRoutes from './routes/projects.ts';
import ideasRoutes from './routes/ideas.ts';
import peopleRoutes from './routes/people.ts';
import commitmentsRoutes from './routes/commitments.ts';
import executionRoutes from './routes/execution.ts';
import notesRoutes from './routes/notes.ts';
import { createNexusMcpHandler } from './mcp/index.ts';
import { processRecurringTasks } from './scheduled/recurring-tasks.ts';
import { dispatchTasks } from './scheduled/task-dispatcher.ts';

// Re-export Durable Objects
export { InboxManager } from './durable-objects/InboxManager.ts';
export { CaptureBuffer } from './durable-objects/CaptureBuffer.ts';
export { SyncManager } from './durable-objects/SyncManager.ts';
export { UserSession } from './durable-objects/UserSession.ts';
export { IdeaExecutor } from './durable-objects/IdeaExecutor.ts';

// Re-export Workflows
export { IdeaToPlanWorkflow } from './workflows/IdeaToPlanWorkflow.ts';
export { TaskExecutorWorkflow } from './workflows/TaskExecutorWorkflow.ts';
export { IdeaPlanningWorkflow } from './workflows/idea-planning-workflow.ts';

// Re-export Cloudflare Workflows
export { IdeaExecutionWorkflow } from './workflows/IdeaExecutionWorkflow.ts';

// Scheduled handler for Cloudflare Cron Triggers
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Cron trigger fired at ${new Date(event.scheduledTime).toISOString()}, cron: ${event.cron}`);

    // Route based on cron pattern
    // Daily at midnight: process recurring tasks
    // Every 15 minutes: dispatch ready tasks
    if (event.cron === '0 0 * * *') {
      // Daily at midnight UTC - process recurring tasks
      ctx.waitUntil(processRecurringTasks(env));
    } else if (event.cron === '*/15 * * * *') {
      // Every 15 minutes - dispatch tasks to executors
      ctx.waitUntil(dispatchTasks(env));
    } else {
      // Unknown cron, run both to be safe
      console.log(`Unknown cron pattern: ${event.cron}, running all scheduled tasks`);
      ctx.waitUntil(processRecurringTasks(env));
      ctx.waitUntil(dispatchTasks(env));
    }
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

// ========================================
// Admin: Register passphrase-to-tenant mapping
// This endpoint allows setting up passphrase-based MCP tenant resolution
// ========================================
app.post('/admin/register-passphrase', async (c) => {
  try {
    const body = await c.req.json();
    const { passphrase, tenant_id, user_id, name, admin_passphrase } = body;

    // Require admin_passphrase to match WRITE_PASSPHRASE for security
    if (!c.env.WRITE_PASSPHRASE) {
      return c.json({ success: false, error: 'WRITE_PASSPHRASE not configured' }, 400);
    }

    if (admin_passphrase !== c.env.WRITE_PASSPHRASE) {
      return c.json({ success: false, error: 'Invalid admin passphrase' }, 401);
    }

    if (!passphrase || !tenant_id || !user_id) {
      return c.json({ success: false, error: 'Missing required fields: passphrase, tenant_id, user_id' }, 400);
    }

    // Verify tenant and user exist
    const tenant = await c.env.DB.prepare(
      'SELECT id FROM tenants WHERE id = ? AND deleted_at IS NULL'
    ).bind(tenant_id).first();

    if (!tenant) {
      return c.json({ success: false, error: 'Tenant not found' }, 404);
    }

    const user = await c.env.DB.prepare(
      'SELECT id FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL'
    ).bind(user_id, tenant_id).first();

    if (!user) {
      return c.json({ success: false, error: 'User not found in tenant' }, 404);
    }

    // Register the mapping
    const result = await registerPassphraseTenant(c.env.DB, passphrase, tenant_id, user_id, name);

    return c.json({
      success: true,
      data: {
        id: result.id,
        passphrase_hash: result.passphraseHash,
        tenant_id,
        user_id,
        name,
        message: 'Passphrase mapping registered. MCP requests will now use this tenant.',
      },
    });
  } catch (error: any) {
    console.error('Register passphrase error:', error);
    if (error.message?.includes('UNIQUE constraint')) {
      return c.json({ success: false, error: 'This passphrase is already registered' }, 409);
    }
    return c.json({ success: false, error: 'Registration failed' }, 500);
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
api.route('/notes', notesRoutes);

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

// ========================================
// Dispatch Endpoint - Batch dispatch ready tasks
// ========================================

api.post('/dispatch/ready', async (c) => {
  const { tenantId, userId } = getAuth(c);

  try {
    const body = await c.req.json().catch(() => ({}));
    const filterExecutorType = body.executor_type as string | undefined;
    const limit = (body.limit as number) || 50;

    // Get tasks with status="next"
    const tasks = await c.env.DB.prepare(`
      SELECT id, user_id, title, description, urgency, importance,
             project_id, domain, due_date, energy_required, source_type, source_reference
      FROM tasks
      WHERE tenant_id = ? AND user_id = ? AND status = 'next' AND deleted_at IS NULL
      ORDER BY urgency DESC, importance DESC, created_at ASC
      LIMIT ?
    `).bind(tenantId, userId, limit * 2).all<{
      id: string;
      user_id: string;
      title: string;
      description: string | null;
      urgency: number;
      importance: number;
      project_id: string | null;
      domain: string;
      due_date: string | null;
      energy_required: string;
      source_type: string | null;
      source_reference: string | null;
    }>();

    if (!tasks.results || tasks.results.length === 0) {
      return c.json({
        success: true,
        data: {
          dispatched: 0,
          message: 'No tasks with status="next" found',
        },
      });
    }

    // Auto-detect executor patterns
    const patterns: Array<{ pattern: RegExp; executor: string }> = [
      { pattern: /^\[implement\]/i, executor: 'claude-code' },
      { pattern: /^\[deploy\]/i, executor: 'claude-code' },
      { pattern: /^\[fix\]/i, executor: 'claude-code' },
      { pattern: /^\[refactor\]/i, executor: 'claude-code' },
      { pattern: /^\[test\]/i, executor: 'claude-code' },
      { pattern: /^\[debug\]/i, executor: 'claude-code' },
      { pattern: /^\[code\]/i, executor: 'claude-code' },
      { pattern: /^\[research\]/i, executor: 'claude-ai' },
      { pattern: /^\[design\]/i, executor: 'claude-ai' },
      { pattern: /^\[document\]/i, executor: 'claude-ai' },
      { pattern: /^\[analyze\]/i, executor: 'claude-ai' },
      { pattern: /^\[plan\]/i, executor: 'claude-ai' },
      { pattern: /^\[write\]/i, executor: 'claude-ai' },
      { pattern: /^\[human\]/i, executor: 'human' },
      { pattern: /^\[review\]/i, executor: 'human' },
      { pattern: /^\[approve\]/i, executor: 'human' },
      { pattern: /^\[decide\]/i, executor: 'human' },
      { pattern: /^\[call\]/i, executor: 'human' },
      { pattern: /^\[meeting\]/i, executor: 'human' },
    ];

    // Helper to safely decrypt
    const safeDecrypt = async (value: unknown, key: CryptoKey): Promise<string> => {
      if (!value || typeof value !== 'string') return '';
      try {
        const { decryptField } = await import('./lib/encryption.ts');
        return await decryptField(value, key);
      } catch {
        return value;
      }
    };

    const { getEncryptionKey } = await import('./lib/encryption.ts');
    const encryptionKey = await getEncryptionKey(c.env.KV, tenantId);
    const now = new Date().toISOString();

    const dispatched: Array<{ task_id: string; task_title: string; executor_type: string; queue_id: string }> = [];
    const skipped: Array<{ task_id: string; reason: string }> = [];

    for (const task of tasks.results) {
      if (dispatched.length >= limit) break;

      // Check if already queued
      const existing = await c.env.DB.prepare(`
        SELECT id FROM execution_queue
        WHERE task_id = ? AND status IN ('queued', 'claimed', 'dispatched')
      `).bind(task.id).first<{ id: string }>();

      if (existing) {
        skipped.push({ task_id: task.id, reason: 'already_queued' });
        continue;
      }

      // Decrypt title
      const decryptedTitle = await safeDecrypt(task.title, encryptionKey);

      // Determine executor type
      let executorType = 'human';
      for (const { pattern, executor } of patterns) {
        if (pattern.test(decryptedTitle)) {
          executorType = executor;
          break;
        }
      }

      // Filter by executor type if specified
      if (filterExecutorType && executorType !== filterExecutorType) {
        skipped.push({ task_id: task.id, reason: `executor_mismatch (${executorType})` });
        continue;
      }

      // Calculate priority
      const priority = (task.urgency || 3) * (task.importance || 3);

      // Build context
      const context = JSON.stringify({
        task_title: decryptedTitle,
        task_description: task.description ? await safeDecrypt(task.description, encryptionKey) : null,
        project_id: task.project_id,
        domain: task.domain,
        due_date: task.due_date,
        energy_required: task.energy_required,
        source_type: task.source_type,
        source_reference: task.source_reference,
      });

      // Add to queue
      const queueId = crypto.randomUUID();
      await c.env.DB.prepare(`
        INSERT INTO execution_queue (
          id, tenant_id, user_id, task_id, executor_type, status,
          priority, queued_at, context, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
      `).bind(queueId, tenantId, userId, task.id, executorType, priority, now, context, now, now).run();

      // Log
      const logId = crypto.randomUUID();
      await c.env.DB.prepare(`
        INSERT INTO dispatch_log (id, tenant_id, queue_entry_id, task_id, executor_type, action, details, created_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
      `).bind(logId, tenantId, queueId, task.id, executorType, JSON.stringify({ source: 'api_batch_dispatch' }), now).run();

      dispatched.push({
        task_id: task.id,
        task_title: decryptedTitle,
        executor_type: executorType,
        queue_id: queueId,
      });
    }

    // Summarize by executor type
    const byExecutor: Record<string, number> = {};
    for (const d of dispatched) {
      byExecutor[d.executor_type] = (byExecutor[d.executor_type] || 0) + 1;
    }

    return c.json({
      success: true,
      data: {
        dispatched: dispatched.length,
        skipped: skipped.length,
        by_executor: byExecutor,
        tasks: dispatched,
      },
    });
  } catch (error) {
    console.error('Dispatch ready error:', error);
    return c.json({ success: false, error: 'Failed to dispatch tasks' }, 500);
  }
});

app.route('/api', api);

// ========================================
// MCP Server Endpoint (root level for mcp-remote compatibility)
// Uses Mnemo-style passphrase auth instead of full OAuth
// - Read operations: No auth required
// - Write operations: Require WRITE_PASSPHRASE in tool arguments
// - Tenant resolution: Uses passphrase from tool args or falls back to default
// ========================================
app.all('/mcp', async (c) => {
  // Try to resolve tenant from passphrase in the request body
  // MCP JSON-RPC format: {"method": "tools/call", "params": {"name": "...", "arguments": {"passphrase": "..."}}}
  let resolvedTenant: { tenantId: string; userId: string } | null = null;

  if (c.req.method === 'POST') {
    try {
      // Clone the request to read the body without consuming it
      const clonedReq = c.req.raw.clone();
      const body = await clonedReq.json() as Record<string, unknown>;

      // Extract passphrase from various places in MCP protocol
      let passphrase: string | undefined;

      // Check in tool call arguments (JSON-RPC format)
      const params = body?.params as Record<string, unknown> | undefined;
      const paramsArgs = params?.arguments as Record<string, unknown> | undefined;
      if (paramsArgs?.passphrase && typeof paramsArgs.passphrase === 'string') {
        passphrase = paramsArgs.passphrase;
      }
      // Check in direct arguments (some MCP implementations)
      const directArgs = body?.arguments as Record<string, unknown> | undefined;
      if (!passphrase && directArgs?.passphrase && typeof directArgs.passphrase === 'string') {
        passphrase = directArgs.passphrase;
      }

      if (passphrase) {
        const tenantInfo = await lookupTenantByPassphrase(c.env.DB, passphrase);
        if (tenantInfo) {
          resolvedTenant = { tenantId: tenantInfo.tenantId, userId: tenantInfo.userId };
          console.log(`MCP: Resolved tenant from passphrase: ${tenantInfo.tenantId} (${tenantInfo.name})`);
        }
      }
    } catch (e) {
      // Ignore JSON parsing errors - might be SSE or other format
    }
  }

  // Use resolved tenant or fall back to default
  const mcpTenant = resolvedTenant || await getOrCreateMcpTenant(c.env);

  const handler = createNexusMcpHandler(c.env, mcpTenant.tenantId, mcpTenant.userId);
  return handler(c.req.raw, c.env, c.executionCtx);
});

/**
 * Get the primary tenant/user for MCP access
 *
 * SINGLE-TENANT MODE: MCP requests use the same tenant as CLI/API
 * This ensures data created via Claude.ai MCP is visible in CLI and vice versa.
 *
 * Priority:
 * 1. Use PRIMARY_TENANT_ID + PRIMARY_USER_ID env vars (simplest, most reliable)
 * 2. Use WRITE_PASSPHRASE to look up registered tenant (passphrase_tenants table)
 * 3. Find the first owner user in the system
 * 4. Fall back to creating an MCP-specific tenant (legacy behavior)
 */
async function getOrCreateMcpTenant(env: Env): Promise<{ tenantId: string; userId: string }> {
  // Option 0 (HIGHEST PRIORITY): Use explicit tenant/user IDs from env
  // This is the simplest and most reliable mechanism
  if (env.PRIMARY_TENANT_ID && env.PRIMARY_USER_ID) {
    console.log(`MCP using PRIMARY_TENANT_ID: ${env.PRIMARY_TENANT_ID}`);
    return { tenantId: env.PRIMARY_TENANT_ID, userId: env.PRIMARY_USER_ID };
  }

  // Option 1: Use WRITE_PASSPHRASE to resolve tenant from passphrase_tenants table
  if (env.WRITE_PASSPHRASE) {
    const tenantInfo = await lookupTenantByPassphrase(env.DB, env.WRITE_PASSPHRASE);
    if (tenantInfo) {
      console.log(`MCP using passphrase-mapped tenant: ${tenantInfo.tenantId} (${tenantInfo.name})`);
      return { tenantId: tenantInfo.tenantId, userId: tenantInfo.userId };
    }
    // Passphrase not mapped yet - fall through to other options
    console.log('MCP: WRITE_PASSPHRASE set but no tenant mapping found.');
  }

  // Option 2: Single-tenant mode - find the first/primary owner in the system
  const primaryOwner = await env.DB.prepare(`
    SELECT u.id as user_id, u.tenant_id
    FROM users u
    JOIN tenants t ON u.tenant_id = t.id
    WHERE u.role = 'owner' AND u.deleted_at IS NULL AND t.deleted_at IS NULL
    ORDER BY u.created_at ASC
    LIMIT 1
  `).first<{ user_id: string; tenant_id: string }>();

  if (primaryOwner) {
    console.log(`MCP using primary tenant: ${primaryOwner.tenant_id}`);
    return { tenantId: primaryOwner.tenant_id, userId: primaryOwner.user_id };
  }

  // Option 3: Fall back to creating MCP-specific tenant (first-time setup)
  const MCP_TENANT_NAME = 'Primary Tenant';
  const MCP_USER_EMAIL = 'owner@nexus.local';

  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO tenants (id, name, encryption_key_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(tenantId, MCP_TENANT_NAME, `tenant:${tenantId}:key`, now, now).run();

  await env.DB.prepare(`
    INSERT INTO users (id, tenant_id, email, name, role, timezone, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(userId, tenantId, MCP_USER_EMAIL, 'Primary User', 'owner', 'UTC', now, now).run();

  // Generate encryption key for tenant
  await generateTenantKey(env.KV, tenantId);

  console.log(`Created primary tenant: ${tenantId}`);

  return { tenantId, userId };
}

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
