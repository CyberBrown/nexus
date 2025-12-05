import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/index.ts';
import { UnauthorizedError, NotFoundError, ValidationError } from '../lib/errors.ts';

// Authentication session for session lifecycle management
export interface AuthSession {
  id: string;
  tenant_id: string;
  user_id: string;
  device_id: string;
  created_at: string;
  last_activity_at: string;
  expires_at: string;
  revoked_at: string | null;
  status: 'active' | 'expired' | 'revoked';
  ip_address: string | null;
  user_agent: string | null;
}

interface DeviceInfo {
  id: string;
  userId: string;
  deviceName: string;
  deviceType: 'mobile' | 'desktop' | 'tablet' | 'web';
  platform: string;
  userAgent: string;
  ipAddress: string;
  connectedAt: string;
  lastActivity: string;
  status: 'online' | 'away' | 'offline';
  // Link to auth session
  sessionId: string | null;
}

interface UserPreferences {
  timezone: string;
  theme: 'light' | 'dark' | 'auto';
  notifications: {
    enabled: boolean;
    emailNotifications: boolean;
    pushNotifications: boolean;
    sms: boolean;
  };
  language: string;
  dateFormat: string;
  timeFormat: '12h' | '24h';
  weekStartsOn: 0 | 1; // 0 = Sunday, 1 = Monday
  defaultView: 'inbox' | 'today' | 'projects' | 'calendar';
}

interface WebSocketSession {
  webSocket: WebSocket;
  deviceId: string;
  userId: string;
  connectedAt: string;
  lastPing: string;
}

interface SessionState {
  userId: string;
  tenantId: string;
  devices: Map<string, DeviceInfo>;
  preferences: UserPreferences | null;
  lastActivity: string;
  sessionStarted: string;
}

const HEARTBEAT_TIMEOUT = 60000; // 60 seconds
const AWAY_TIMEOUT = 300000; // 5 minutes
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MAX_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const SESSION_INACTIVITY_TIMEOUT_SECONDS = 30 * 60; // 30 minutes
const MAX_CONCURRENT_SESSIONS = 10; // Max sessions per user
const DEFAULT_PREFERENCES: UserPreferences = {
  timezone: 'UTC',
  theme: 'auto',
  notifications: {
    enabled: true,
    emailNotifications: true,
    pushNotifications: true,
    sms: false,
  },
  language: 'en',
  dateFormat: 'YYYY-MM-DD',
  timeFormat: '24h',
  weekStartsOn: 1,
  defaultView: 'inbox',
};

export class UserSession extends DurableObject<Env> {
  private wsConnections: Map<string, WebSocketSession> = new Map();
  private state: SessionState | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  // Authentication sessions (for session lifecycle management)
  private authSessions: Map<string, AuthSession> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore state from storage
    this.ctx.blockConcurrencyWhile(async () => {
      const storedState = await this.ctx.storage.get<{
        userId: string;
        tenantId: string;
        devices: [string, DeviceInfo][];
        preferences: UserPreferences | null;
        lastActivity: string;
        sessionStarted: string;
      }>('sessionState');

      if (storedState) {
        this.state = {
          userId: storedState.userId,
          tenantId: storedState.tenantId,
          devices: new Map(storedState.devices),
          preferences: storedState.preferences,
          lastActivity: storedState.lastActivity,
          sessionStarted: storedState.sessionStarted,
        };
      }

      // Restore auth sessions
      const storedAuthSessions = await this.ctx.storage.get<AuthSession[]>('authSessions');
      if (storedAuthSessions) {
        for (const session of storedAuthSessions) {
          this.authSessions.set(session.id, session);
        }
      }
    });

    // Start heartbeat checker
    this.startHeartbeatChecker();
    // Schedule periodic cleanup of expired sessions
    this.scheduleSessionCleanup();
  }

  // Initialize session with user and tenant
  async initialize(userId: string, tenantId: string): Promise<void> {
    if (!this.state) {
      this.state = {
        userId,
        tenantId,
        devices: new Map(),
        preferences: null,
        lastActivity: new Date().toISOString(),
        sessionStarted: new Date().toISOString(),
      };
      await this.persistState();
    }
  }

  // Handle HTTP requests
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    // REST endpoints
    try {
      switch (request.method) {
        case 'GET':
          if (path === '/status') {
            return this.handleStatus();
          }
          if (path === '/devices') {
            return this.handleGetDevices();
          }
          if (path === '/preferences') {
            return this.handleGetPreferences();
          }
          if (path === '/session/validate') {
            return this.handleValidateSession(request);
          }
          if (path === '/session/list') {
            return this.handleListSessions();
          }
          break;

        case 'POST':
          if (path === '/heartbeat') {
            return this.handleHeartbeat(request);
          }
          if (path === '/preferences') {
            return this.handleUpdatePreferences(request);
          }
          if (path === '/device/register') {
            return this.handleRegisterDevice(request);
          }
          if (path === '/session/create') {
            return this.handleCreateSession(request);
          }
          if (path === '/session/refresh') {
            return this.handleRefreshSession(request);
          }
          if (path === '/session/revoke') {
            return this.handleRevokeSession(request);
          }
          if (path === '/session/revoke-all') {
            return this.handleRevokeAllSessions(request);
          }
          break;

        case 'DELETE':
          if (path.startsWith('/device/')) {
            const deviceId = path.split('/')[2];
            if (deviceId) {
              return this.handleDisconnectDevice(deviceId);
            }
          }
          if (path.startsWith('/session/')) {
            const sessionId = path.split('/').pop();
            if (sessionId) {
              return this.handleDeleteSession(sessionId);
            }
          }
          break;
      }

      return Response.json({ success: false, error: 'Not found' }, { status: 404 });
    } catch (error) {
      console.error('UserSession error:', error);

      if (error instanceof UnauthorizedError || error instanceof NotFoundError || error instanceof ValidationError) {
        return Response.json(error.toJSON(), { status: error.statusCode });
      }

      return Response.json(
        { success: false, error: 'Internal server error' },
        { status: 500 }
      );
    }
  }

  // Handle WebSocket connections for real-time presence
  private async handleWebSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const deviceId = url.searchParams.get('deviceId');

    if (!userId || !deviceId) {
      return new Response('Missing userId or deviceId parameter', { status: 400 });
    }

    if (!this.state) {
      return new Response('Session not initialized', { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Accept the WebSocket
    this.ctx.acceptWebSocket(server);

    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();

    this.wsConnections.set(sessionId, {
      webSocket: server,
      deviceId,
      userId,
      connectedAt: now,
      lastPing: now,
    });

    // Store session ID on the WebSocket for later reference
    (server as unknown as Record<string, string>).__sessionId = sessionId;

    // Update device status to online
    if (this.state) {
      const device = this.state.devices.get(deviceId);
      if (device) {
        device.status = 'online';
        device.lastActivity = now;
        await this.persistState();
      }

      // Send initial state
      server.send(JSON.stringify({
        type: 'connected',
        sessionId,
        userId: this.state.userId,
        devices: Array.from(this.state.devices.values()),
        preferences: this.state.preferences ?? DEFAULT_PREFERENCES,
      }));

      // Broadcast presence update to other devices
      this.broadcast({
        type: 'presence_update',
        deviceId,
        status: 'online',
        timestamp: now,
      }, sessionId);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // Handle WebSocket messages
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const sessionId = (ws as unknown as Record<string, string>).__sessionId;
    if (!sessionId) return;

    const session = this.wsConnections.get(sessionId);

    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return;
    }

    try {
      const data = JSON.parse(message as string);
      const now = new Date().toISOString();

      switch (data.type) {
        case 'ping':
          session.lastPing = now;
          ws.send(JSON.stringify({ type: 'pong', timestamp: now }));

          // Update device activity
          if (this.state) {
            const device = this.state.devices.get(session.deviceId);
            if (device) {
              device.lastActivity = now;
              device.status = 'online';
              await this.persistState();
            }
          }
          break;

        case 'activity':
          // Update last activity timestamp
          if (this.state) {
            this.state.lastActivity = now;
            const device = this.state.devices.get(session.deviceId);
            if (device) {
              device.lastActivity = now;
              device.status = 'online';
              await this.persistState();
            }
          }
          break;

        case 'status_change':
          // User manually changing status (online, away)
          if (this.state && data.status) {
            const device = this.state.devices.get(session.deviceId);
            if (device && ['online', 'away', 'offline'].includes(data.status)) {
              device.status = data.status;
              await this.persistState();

              // Broadcast to all devices
              this.broadcast({
                type: 'presence_update',
                deviceId: session.deviceId,
                status: data.status,
                timestamp: now,
              });
            }
          }
          break;

        case 'preferences_sync':
          // Client requesting preference sync
          ws.send(JSON.stringify({
            type: 'preferences_updated',
            preferences: this.state?.preferences ?? DEFAULT_PREFERENCES,
          }));
          break;
      }
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      console.error('WebSocket message error:', error);
    }
  }

  // Handle WebSocket close
  override async webSocketClose(ws: WebSocket, code: number, _reason: string): Promise<void> {
    const sessionId = (ws as unknown as Record<string, string>).__sessionId;
    if (!sessionId) return;

    const session = this.wsConnections.get(sessionId);

    if (session && this.state) {
      // Update device status
      const device = this.state.devices.get(session.deviceId);
      if (device) {
        device.status = 'offline';
        device.lastActivity = new Date().toISOString();
        await this.persistState();
      }

      // Broadcast presence update
      this.broadcast({
        type: 'presence_update',
        deviceId: session.deviceId,
        status: 'offline',
        timestamp: new Date().toISOString(),
      }, sessionId);

      this.wsConnections.delete(sessionId);
    }

    console.log(`WebSocket closed with code ${code}`);
  }

  // Get session status
  private handleStatus(): Response {
    if (!this.state) {
      return Response.json({
        success: false,
        error: 'Session not initialized',
      }, { status: 400 });
    }

    return Response.json({
      success: true,
      data: {
        userId: this.state.userId,
        tenantId: this.state.tenantId,
        connectedDevices: Array.from(this.state.devices.values()).filter(d => d.status === 'online').length,
        totalDevices: this.state.devices.size,
        activeWebSockets: this.wsConnections.size,
        lastActivity: this.state.lastActivity,
        sessionStarted: this.state.sessionStarted,
        totalAuthSessions: this.authSessions.size,
        activeAuthSessions: Array.from(this.authSessions.values()).filter(s => s.status === 'active').length,
      },
    });
  }

  // Handle heartbeat
  private async handleHeartbeat(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        userId: string;
        deviceId: string;
        tenantId?: string;
      };

      const { userId, deviceId, tenantId } = body;

      if (!userId || !deviceId) {
        return Response.json({ success: false, error: 'Missing userId or deviceId' }, { status: 400 });
      }

      // Initialize if needed
      if (!this.state && tenantId) {
        await this.initialize(userId, tenantId);
      }

      if (!this.state) {
        return Response.json({ success: false, error: 'Session not initialized' }, { status: 400 });
      }

      const now = new Date().toISOString();
      this.state.lastActivity = now;

      const device = this.state.devices.get(deviceId);
      if (device) {
        device.lastActivity = now;
        device.status = 'online';
        await this.persistState();
      }

      return Response.json({
        success: true,
        data: {
          timestamp: now,
          status: device?.status ?? 'unknown',
        },
      });
    } catch (error) {
      console.error('Heartbeat error:', error);
      return Response.json({ success: false, error: 'Heartbeat failed' }, { status: 500 });
    }
  }

  // Get all devices
  private handleGetDevices(): Response {
    if (!this.state) {
      return Response.json({
        success: false,
        error: 'Session not initialized',
      }, { status: 400 });
    }

    return Response.json({
      success: true,
      data: {
        devices: Array.from(this.state.devices.values()),
      },
    });
  }

  // Register a new device
  private async handleRegisterDevice(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        userId: string;
        tenantId: string;
        deviceName: string;
        deviceType: 'mobile' | 'desktop' | 'tablet' | 'web';
        platform: string;
        userAgent: string;
      };

      const { userId, tenantId, deviceName, deviceType, platform, userAgent } = body;

      if (!userId || !tenantId || !deviceName || !deviceType) {
        return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
      }

      // Initialize if needed
      if (!this.state) {
        await this.initialize(userId, tenantId);
      }

      if (!this.state) {
        return Response.json({ success: false, error: 'Failed to initialize session' }, { status: 500 });
      }

      const deviceId = crypto.randomUUID();
      const now = new Date().toISOString();
      const ipAddress = request.headers.get('CF-Connecting-IP') ?? 'unknown';

      const device: DeviceInfo = {
        id: deviceId,
        userId,
        deviceName,
        deviceType,
        platform,
        userAgent,
        ipAddress,
        connectedAt: now,
        lastActivity: now,
        status: 'online',
        sessionId: null,
      };

      this.state.devices.set(deviceId, device);
      await this.persistState();

      // Broadcast to other devices
      this.broadcast({
        type: 'device_registered',
        device,
        timestamp: now,
      });

      return Response.json({
        success: true,
        data: { device },
      });
    } catch (error) {
      console.error('Register device error:', error);
      return Response.json({ success: false, error: 'Failed to register device' }, { status: 500 });
    }
  }

  // Disconnect a device
  private async handleDisconnectDevice(deviceId: string): Promise<Response> {
    if (!this.state) {
      return Response.json({
        success: false,
        error: 'Session not initialized',
      }, { status: 400 });
    }

    const device = this.state.devices.get(deviceId);
    if (!device) {
      return Response.json({
        success: false,
        error: 'Device not found',
      }, { status: 404 });
    }

    // Close any active WebSocket connections for this device
    for (const [sessionId, session] of this.wsConnections.entries()) {
      if (session.deviceId === deviceId) {
        session.webSocket.close(1000, 'Device disconnected');
        this.wsConnections.delete(sessionId);
      }
    }

    this.state.devices.delete(deviceId);
    await this.persistState();

    // Broadcast to remaining devices
    this.broadcast({
      type: 'device_disconnected',
      deviceId,
      timestamp: new Date().toISOString(),
    });

    return Response.json({
      success: true,
      data: { deviceId },
    });
  }

  // Get user preferences
  private handleGetPreferences(): Response {
    if (!this.state) {
      return Response.json({
        success: false,
        error: 'Session not initialized',
      }, { status: 400 });
    }

    return Response.json({
      success: true,
      data: {
        preferences: this.state.preferences ?? DEFAULT_PREFERENCES,
      },
    });
  }

  // Update user preferences
  private async handleUpdatePreferences(request: Request): Promise<Response> {
    if (!this.state) {
      return Response.json({
        success: false,
        error: 'Session not initialized',
      }, { status: 400 });
    }

    try {
      const body = await request.json() as { preferences: Partial<UserPreferences> };

      if (!body.preferences) {
        return Response.json({ success: false, error: 'Missing preferences' }, { status: 400 });
      }

      // Merge with existing preferences
      this.state.preferences = {
        ...(this.state.preferences ?? DEFAULT_PREFERENCES),
        ...body.preferences,
      };

      await this.persistState();

      // Broadcast to all connected devices
      this.broadcast({
        type: 'preferences_updated',
        preferences: this.state.preferences,
        timestamp: new Date().toISOString(),
      });

      return Response.json({
        success: true,
        data: {
          preferences: this.state.preferences,
        },
      });
    } catch (error) {
      console.error('Update preferences error:', error);
      return Response.json({ success: false, error: 'Failed to update preferences' }, { status: 500 });
    }
  }

  // Persist state to durable storage
  private async persistState(): Promise<void> {
    if (!this.state) return;

    await this.ctx.storage.put('sessionState', {
      userId: this.state.userId,
      tenantId: this.state.tenantId,
      devices: Array.from(this.state.devices.entries()),
      preferences: this.state.preferences,
      lastActivity: this.state.lastActivity,
      sessionStarted: this.state.sessionStarted,
    });
  }

  // ============================================
  // Session Lifecycle Management Methods
  // ============================================

  // Create a new authentication session
  private async handleCreateSession(request: Request): Promise<Response> {
    const body = await request.json() as {
      tenant_id: string;
      user_id: string;
      device_id: string;
      ttl_seconds?: number;
    };

    const { tenant_id, user_id, device_id } = body;

    if (!tenant_id || !user_id || !device_id) {
      throw new ValidationError('Missing required fields: tenant_id, user_id, device_id');
    }

    // Initialize state if not set
    if (!this.state) {
      await this.initialize(user_id, tenant_id);
    }

    // Verify tenant/user match
    if (this.state!.tenantId !== tenant_id || this.state!.userId !== user_id) {
      throw new UnauthorizedError('Tenant or user ID mismatch');
    }

    // Check max concurrent sessions
    const activeSessions = Array.from(this.authSessions.values()).filter(
      s => s.status === 'active'
    );

    if (activeSessions.length >= MAX_CONCURRENT_SESSIONS) {
      // Revoke oldest session
      const oldestSession = activeSessions.sort(
        (a, b) => new Date(a.last_activity_at).getTime() - new Date(b.last_activity_at).getTime()
      )[0];
      if (oldestSession) {
        await this.revokeAuthSession(oldestSession.id, 'max_sessions_exceeded');
      }
    }

    // Create auth session
    const now = new Date().toISOString();
    const ttl = Math.min(body.ttl_seconds ?? DEFAULT_SESSION_TTL_SECONDS, MAX_SESSION_TTL_SECONDS);
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const authSession: AuthSession = {
      id: crypto.randomUUID(),
      tenant_id,
      user_id,
      device_id,
      created_at: now,
      last_activity_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      status: 'active',
      ip_address: request.headers.get('CF-Connecting-IP'),
      user_agent: request.headers.get('User-Agent'),
    };

    this.authSessions.set(authSession.id, authSession);
    await this.persistAuthSessions();

    // Link device to session if it exists
    const device = this.state!.devices.get(device_id);
    if (device) {
      device.sessionId = authSession.id;
      await this.persistState();
    }

    // Broadcast to connected clients
    this.broadcast({
      type: 'auth_session_created',
      session_id: authSession.id,
      device_id,
    });

    return Response.json({
      success: true,
      data: {
        session: this.sanitizeAuthSession(authSession),
      },
    }, { status: 201 });
  }

  // Refresh/extend an authentication session
  private async handleRefreshSession(request: Request): Promise<Response> {
    const body = await request.json() as {
      session_id: string;
      extend_ttl?: boolean;
      ttl_seconds?: number;
    };
    const { session_id, extend_ttl = true, ttl_seconds } = body;

    if (!session_id) {
      throw new ValidationError('Missing required field: session_id');
    }

    const session = this.authSessions.get(session_id);
    if (!session) {
      throw new NotFoundError('Session', session_id);
    }

    // Check if expired or revoked
    if (session.status === 'revoked') {
      throw new UnauthorizedError('Session has been revoked');
    }

    const now = new Date();
    if (new Date(session.expires_at) < now) {
      session.status = 'expired';
      await this.persistAuthSessions();
      throw new UnauthorizedError('Session has expired');
    }

    // Update last activity
    session.last_activity_at = now.toISOString();

    // Extend expiration if requested
    if (extend_ttl) {
      const ttl = Math.min(ttl_seconds ?? DEFAULT_SESSION_TTL_SECONDS, MAX_SESSION_TTL_SECONDS);
      session.expires_at = new Date(now.getTime() + ttl * 1000).toISOString();
    }

    await this.persistAuthSessions();

    // Broadcast update
    this.broadcast({
      type: 'auth_session_refreshed',
      session_id: session.id,
    });

    return Response.json({
      success: true,
      data: {
        session: this.sanitizeAuthSession(session),
      },
    });
  }

  // Validate an authentication session
  private async handleValidateSession(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('session_id');

    if (!sessionId) {
      throw new ValidationError('Missing required parameter: session_id');
    }

    const session = this.authSessions.get(sessionId);
    if (!session) {
      throw new NotFoundError('Session', sessionId);
    }

    // Check status
    if (session.status === 'revoked') {
      return Response.json({
        success: false,
        error: 'Session has been revoked',
        data: { valid: false, reason: 'revoked' },
      }, { status: 401 });
    }

    // Check expiration
    const now = new Date();
    if (new Date(session.expires_at) < now) {
      session.status = 'expired';
      await this.persistAuthSessions();
      return Response.json({
        success: false,
        error: 'Session has expired',
        data: { valid: false, reason: 'expired' },
      }, { status: 401 });
    }

    // Check inactivity timeout
    const lastActivity = new Date(session.last_activity_at);
    const inactiveSeconds = (now.getTime() - lastActivity.getTime()) / 1000;

    if (inactiveSeconds > SESSION_INACTIVITY_TIMEOUT_SECONDS) {
      session.status = 'expired';
      await this.persistAuthSessions();
      return Response.json({
        success: false,
        error: 'Session expired due to inactivity',
        data: { valid: false, reason: 'inactivity' },
      }, { status: 401 });
    }

    // Update last activity
    session.last_activity_at = now.toISOString();
    await this.persistAuthSessions();

    return Response.json({
      success: true,
      data: {
        valid: true,
        session: this.sanitizeAuthSession(session),
      },
    });
  }

  // Revoke a specific authentication session
  private async handleRevokeSession(request: Request): Promise<Response> {
    const body = await request.json() as { session_id: string };
    const { session_id } = body;

    if (!session_id) {
      throw new ValidationError('Missing required field: session_id');
    }

    await this.revokeAuthSession(session_id, 'user_request');

    return Response.json({
      success: true,
      data: { message: 'Session revoked successfully' },
    });
  }

  // Revoke all authentication sessions (logout from all devices)
  private async handleRevokeAllSessions(request: Request): Promise<Response> {
    const body = await request.json() as { except_session_id?: string };
    const exceptSessionId = body.except_session_id;

    let count = 0;

    for (const [sessionId, session] of this.authSessions.entries()) {
      if (sessionId === exceptSessionId) continue;
      if (session.status !== 'active') continue;

      session.status = 'revoked';
      session.revoked_at = new Date().toISOString();
      count++;
    }

    if (count > 0) {
      await this.persistAuthSessions();

      // Broadcast
      this.broadcast({
        type: 'auth_sessions_revoked',
        count,
        except_session_id: exceptSessionId,
      });
    }

    return Response.json({
      success: true,
      data: {
        message: `Revoked ${count} session(s)`,
        revoked_count: count,
      },
    });
  }

  // List all authentication sessions
  private handleListSessions(): Response {
    const sessions = Array.from(this.authSessions.values()).map(s => this.sanitizeAuthSession(s));

    return Response.json({
      success: true,
      data: {
        sessions,
        total: sessions.length,
        active: sessions.filter(s => s.status === 'active').length,
      },
    });
  }

  // Delete an authentication session (hard delete)
  private async handleDeleteSession(sessionId: string): Promise<Response> {
    const session = this.authSessions.get(sessionId);
    if (!session) {
      throw new NotFoundError('Session', sessionId);
    }

    this.authSessions.delete(sessionId);
    await this.persistAuthSessions();

    // Unlink device if linked
    if (this.state) {
      for (const device of this.state.devices.values()) {
        if (device.sessionId === sessionId) {
          device.sessionId = null;
        }
      }
      await this.persistState();
    }

    return Response.json({
      success: true,
      data: { message: 'Session deleted successfully' },
    });
  }

  // Helper: Revoke an auth session
  private async revokeAuthSession(sessionId: string, reason: string): Promise<void> {
    const session = this.authSessions.get(sessionId);
    if (!session) {
      throw new NotFoundError('Session', sessionId);
    }

    session.status = 'revoked';
    session.revoked_at = new Date().toISOString();
    await this.persistAuthSessions();

    // Broadcast revocation
    this.broadcast({
      type: 'auth_session_revoked',
      session_id: sessionId,
      reason,
    });
  }

  // Helper: Clean up expired authentication sessions
  private async cleanupExpiredAuthSessions(): Promise<number> {
    const now = new Date();
    let count = 0;

    for (const [sessionId, session] of this.authSessions.entries()) {
      // Mark expired sessions
      if (session.status === 'active' && new Date(session.expires_at) < now) {
        session.status = 'expired';
        count++;
      }

      // Delete old expired/revoked sessions (older than 30 days)
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      if (
        (session.status === 'expired' || session.status === 'revoked') &&
        new Date(session.last_activity_at) < thirtyDaysAgo
      ) {
        this.authSessions.delete(sessionId);
        count++;
      }
    }

    if (count > 0) {
      await this.persistAuthSessions();
    }

    return count;
  }

  // Helper: Schedule periodic session cleanup
  private scheduleSessionCleanup(): void {
    // Schedule cleanup every hour
    const oneHour = 60 * 60 * 1000;
    this.ctx.storage.setAlarm(Date.now() + oneHour);
  }

  // Helper: Persist auth sessions to storage
  private async persistAuthSessions(): Promise<void> {
    const sessions = Array.from(this.authSessions.values());
    await this.ctx.storage.put('authSessions', sessions);
  }

  // Helper: Sanitize auth session data (remove sensitive fields)
  private sanitizeAuthSession(session: AuthSession): Omit<AuthSession, 'ip_address' | 'user_agent'> {
    const { ip_address, user_agent, ...sanitized } = session;
    return sanitized;
  }

  // Broadcast message to all connected WebSocket sessions
  private broadcast(message: Record<string, unknown>, excludeSessionId?: string): void {
    const payload = JSON.stringify(message);

    for (const [sessionId, session] of this.wsConnections.entries()) {
      if (excludeSessionId && sessionId === excludeSessionId) continue;

      try {
        session.webSocket.send(payload);
      } catch {
        // WebSocket might be closed, will be cleaned up on next close event
      }
    }
  }

  // Start heartbeat checker to mark inactive devices as away/offline
  private startHeartbeatChecker(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(async () => {
      if (!this.state) return;

      const now = Date.now();
      let stateChanged = false;

      for (const device of this.state.devices.values()) {
        const lastActivity = new Date(device.lastActivity).getTime();
        const timeSinceActivity = now - lastActivity;

        if (device.status === 'online' && timeSinceActivity > AWAY_TIMEOUT) {
          device.status = 'away';
          stateChanged = true;

          this.broadcast({
            type: 'presence_update',
            deviceId: device.id,
            status: 'away',
            timestamp: new Date().toISOString(),
          });
        }
      }

      if (stateChanged) {
        await this.persistState();
      }
    }, HEARTBEAT_TIMEOUT);
  }

  // Alarm handler for cleanup and maintenance
  override async alarm(): Promise<void> {
    // Clean up expired auth sessions
    await this.cleanupExpiredAuthSessions();

    // Clean up old offline devices (older than 30 days)
    if (this.state) {
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      let stateChanged = false;

      for (const [deviceId, device] of this.state.devices.entries()) {
        if (device.status === 'offline') {
          const lastActivity = new Date(device.lastActivity).getTime();
          if (lastActivity < thirtyDaysAgo) {
            this.state.devices.delete(deviceId);
            stateChanged = true;
          }
        }
      }

      if (stateChanged) {
        await this.persistState();
      }
    }

    // Reschedule cleanup
    this.scheduleSessionCleanup();
  }
}
