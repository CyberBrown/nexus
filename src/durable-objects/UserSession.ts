import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/index.ts';

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
  private sessions: Map<string, WebSocketSession> = new Map();
  private state: SessionState | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

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
    });

    // Start heartbeat checker
    this.startHeartbeatChecker();
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
        break;

      case 'DELETE':
        if (path.startsWith('/device/')) {
          const deviceId = path.split('/')[2];
          return this.handleDisconnectDevice(deviceId);
        }
        break;
    }

    return new Response('Not found', { status: 404 });
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

    this.sessions.set(sessionId, {
      webSocket: server,
      deviceId,
      userId,
      connectedAt: now,
      lastPing: now,
    });

    // Store session ID on the WebSocket for later reference
    (server as unknown as Record<string, string>).__sessionId = sessionId;

    // Update device status to online
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

    return new Response(null, { status: 101, webSocket: client });
  }

  // Handle WebSocket messages
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const sessionId = (ws as unknown as Record<string, string>).__sessionId;
    const session = this.sessions.get(sessionId);

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
    const session = this.sessions.get(sessionId);

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

      this.sessions.delete(sessionId);
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
        activeWebSockets: this.sessions.size,
        lastActivity: this.state.lastActivity,
        sessionStarted: this.state.sessionStarted,
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
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.deviceId === deviceId) {
        session.webSocket.close(1000, 'Device disconnected');
        this.sessions.delete(sessionId);
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

  // Broadcast message to all connected WebSocket sessions
  private broadcast(message: Record<string, unknown>, excludeSessionId?: string): void {
    const payload = JSON.stringify(message);

    for (const [sessionId, session] of this.sessions.entries()) {
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
  }
}
