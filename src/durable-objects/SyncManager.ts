import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/index.ts';

// Device registration for tracking sync state
interface DeviceInfo {
  device_id: string;
  device_name: string;
  platform: string;
  last_sync: string;
  last_sequence: number;
  connected: boolean;
}

// Change log entry for tracking modifications
interface ChangeLogEntry {
  sequence: number;
  timestamp: string;
  device_id: string;
  entity_type: 'task' | 'project' | 'inbox_item' | 'idea' | 'person' | 'commitment';
  entity_id: string;
  operation: 'create' | 'update' | 'delete';
  changes: Record<string, unknown>;
  user_id: string;
}

// Sync request payload
interface SyncPushRequest {
  device_id: string;
  device_name: string;
  platform: string;
  last_sequence: number;
  changes: Omit<ChangeLogEntry, 'sequence' | 'timestamp'>[];
}

// Sync response payload
interface SyncPullRequest {
  device_id: string;
  since_sequence: number;
}

// Conflict detection result
interface ConflictInfo {
  entity_type: string;
  entity_id: string;
  conflicting_changes: ChangeLogEntry[];
  resolution: 'last_write_wins' | 'manual_required';
  winning_change?: ChangeLogEntry;
}

// WebSocket session for real-time sync
interface WebSocketSession {
  webSocket: WebSocket;
  userId: string;
  deviceId: string;
  connectedAt: string;
}

export class SyncManager extends DurableObject<Env> {
  private sessions: Map<string, WebSocketSession> = new Map();
  private devices: Map<string, DeviceInfo> = new Map();
  private changeLog: ChangeLogEntry[] = [];
  private currentSequence = 0;
  private tenantId: string | null = null;
  private pendingChanges: Map<string, ChangeLogEntry[]> = new Map(); // deviceId -> changes

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore state from storage
    this.ctx.blockConcurrencyWhile(async () => {
      this.tenantId = await this.ctx.storage.get('tenantId') ?? null;
      this.currentSequence = await this.ctx.storage.get('currentSequence') ?? 0;
      this.changeLog = await this.ctx.storage.get('changeLog') ?? [];

      const devicesData = await this.ctx.storage.get<[string, DeviceInfo][]>('devices');
      if (devicesData) {
        this.devices = new Map(devicesData);
      }

      const pendingData = await this.ctx.storage.get<[string, ChangeLogEntry[]][]>('pendingChanges');
      if (pendingData) {
        this.pendingChanges = new Map(pendingData);
      }
    });
  }

  // Initialize with tenant ID (called once per tenant)
  async initialize(tenantId: string): Promise<void> {
    this.tenantId = tenantId;
    await this.ctx.storage.put('tenantId', tenantId);
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
      case 'POST':
        if (path === '/push') {
          return this.handlePush(request);
        }
        if (path === '/pull') {
          return this.handlePull(request);
        }
        break;
      case 'GET':
        if (path === '/status') {
          return this.handleStatus();
        }
        if (path === '/pending') {
          return this.handlePending(request);
        }
        break;
    }

    return new Response('Not found', { status: 404 });
  }

  // Handle WebSocket connections for real-time sync
  private async handleWebSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    const deviceId = url.searchParams.get('deviceId');

    if (!userId || !deviceId) {
      return new Response('Missing userId or deviceId parameter', { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Accept the WebSocket
    this.ctx.acceptWebSocket(server);

    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      webSocket: server,
      userId,
      deviceId,
      connectedAt: new Date().toISOString(),
    });

    // Store session ID on the WebSocket for later reference
    (server as unknown as Record<string, string>).__sessionId = sessionId;

    // Mark device as connected
    const device = this.devices.get(deviceId);
    if (device) {
      device.connected = true;
      await this.persistDevices();
    }

    // Send initial state
    server.send(JSON.stringify({
      type: 'connected',
      sessionId,
      currentSequence: this.currentSequence,
      pendingChanges: this.pendingChanges.get(deviceId)?.length ?? 0,
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  // Handle WebSocket messages
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const data = JSON.parse(message as string);

      switch (data.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        case 'subscribe':
          // Client subscribing to specific events
          ws.send(JSON.stringify({ type: 'subscribed', events: data.events }));
          break;
        case 'ack':
          // Client acknowledging receipt of changes up to sequence
          await this.handleAcknowledgment(data.deviceId, data.sequence);
          break;
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  }

  // Handle WebSocket close
  override async webSocketClose(ws: WebSocket, code: number, _reason: string): Promise<void> {
    const sessionId = (ws as unknown as Record<string, string>).__sessionId;
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        // Mark device as disconnected
        const device = this.devices.get(session.deviceId);
        if (device) {
          device.connected = false;
          await this.persistDevices();
        }
      }
      this.sessions.delete(sessionId);
    }
    console.log(`WebSocket closed with code ${code}`);
  }

  // Handle push (device sending changes to server)
  private async handlePush(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        tenant_id: string;
        user_id: string;
        push: SyncPushRequest;
      };

      const { tenant_id, user_id, push } = body;

      if (!tenant_id || !user_id || !push) {
        return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
      }

      // Initialize tenant if not set
      if (!this.tenantId) {
        await this.initialize(tenant_id);
      }

      // Register or update device
      await this.registerDevice({
        device_id: push.device_id,
        device_name: push.device_name,
        platform: push.platform,
        last_sync: new Date().toISOString(),
        last_sequence: push.last_sequence,
        connected: false,
      });

      // Process incoming changes
      const conflicts: ConflictInfo[] = [];
      const accepted: ChangeLogEntry[] = [];

      for (const change of push.changes) {
        // Check for conflicts
        const conflict = this.detectConflict(change, push.device_id);

        if (conflict) {
          // Apply last-write-wins strategy
          if (conflict.resolution === 'last_write_wins' && conflict.winning_change) {
            const entry = await this.addToChangeLog({
              ...conflict.winning_change,
              device_id: push.device_id,
              user_id,
            });
            accepted.push(entry);
          } else {
            conflicts.push(conflict);
          }
        } else {
          // No conflict, accept change
          const entry = await this.addToChangeLog({
            ...change,
            device_id: push.device_id,
            user_id,
          });
          accepted.push(entry);
        }
      }

      // Broadcast to other devices
      this.broadcast({
        type: 'sync_update',
        changes: accepted.map(e => ({
          sequence: e.sequence,
          entity_type: e.entity_type,
          entity_id: e.entity_id,
          operation: e.operation,
        })),
      }, push.device_id); // Exclude the device that sent the changes

      return Response.json({
        success: true,
        data: {
          accepted_count: accepted.length,
          conflicts_count: conflicts.length,
          current_sequence: this.currentSequence,
          conflicts,
        },
      });
    } catch (error) {
      console.error('Push error:', error);
      return Response.json({ success: false, error: 'Push failed' }, { status: 500 });
    }
  }

  // Handle pull (device requesting changes from server)
  private async handlePull(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        tenant_id: string;
        user_id: string;
        pull: SyncPullRequest;
      };

      const { tenant_id, pull } = body;

      if (!tenant_id || !pull) {
        return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
      }

      // Get changes since requested sequence
      const changes = this.changeLog.filter(entry => entry.sequence > pull.since_sequence);

      // Update device's last sync
      const device = this.devices.get(pull.device_id);
      if (device) {
        device.last_sync = new Date().toISOString();
        device.last_sequence = this.currentSequence;
        await this.persistDevices();
      }

      return Response.json({
        success: true,
        data: {
          changes,
          current_sequence: this.currentSequence,
          has_more: false,
        },
      });
    } catch (error) {
      console.error('Pull error:', error);
      return Response.json({ success: false, error: 'Pull failed' }, { status: 500 });
    }
  }

  // Get DO status
  private handleStatus(): Response {
    return Response.json({
      success: true,
      data: {
        tenantId: this.tenantId,
        connectedClients: this.sessions.size,
        registeredDevices: this.devices.size,
        currentSequence: this.currentSequence,
        changeLogSize: this.changeLog.length,
        devices: Array.from(this.devices.values()),
      },
    });
  }

  // Get pending changes for a device
  private handlePending(request: Request): Response {
    const url = new URL(request.url);
    const deviceId = url.searchParams.get('deviceId');

    if (!deviceId) {
      return Response.json({ success: false, error: 'Missing deviceId' }, { status: 400 });
    }

    const pending = this.pendingChanges.get(deviceId) ?? [];

    return Response.json({
      success: true,
      data: {
        device_id: deviceId,
        pending_count: pending.length,
        changes: pending,
      },
    });
  }

  // Register or update a device
  private async registerDevice(device: DeviceInfo): Promise<void> {
    this.devices.set(device.device_id, device);
    await this.persistDevices();
  }

  // Add entry to change log
  private async addToChangeLog(change: Omit<ChangeLogEntry, 'sequence' | 'timestamp'>): Promise<ChangeLogEntry> {
    this.currentSequence++;

    const entry: ChangeLogEntry = {
      ...change,
      sequence: this.currentSequence,
      timestamp: new Date().toISOString(),
    };

    this.changeLog.push(entry);

    // Trim old entries (keep last 10,000)
    if (this.changeLog.length > 10000) {
      this.changeLog = this.changeLog.slice(-10000);
    }

    await this.ctx.storage.put('currentSequence', this.currentSequence);
    await this.ctx.storage.put('changeLog', this.changeLog);

    // Queue for offline devices
    await this.queueForOfflineDevices(entry);

    return entry;
  }

  // Detect conflicts between incoming change and existing log
  private detectConflict(
    change: Omit<ChangeLogEntry, 'sequence' | 'timestamp'>,
    deviceId: string
  ): ConflictInfo | null {
    // Find recent changes to the same entity from other devices
    const recentChanges = this.changeLog
      .filter(entry =>
        entry.entity_type === change.entity_type &&
        entry.entity_id === change.entity_id &&
        entry.device_id !== deviceId
      )
      .slice(-10); // Look at last 10 changes

    if (recentChanges.length === 0) {
      return null;
    }

    // Get the most recent change
    const mostRecent = recentChanges[recentChanges.length - 1];

    // Simple last-write-wins based on timestamp
    // In a real implementation, you'd use vector clocks
    return {
      entity_type: change.entity_type,
      entity_id: change.entity_id,
      conflicting_changes: recentChanges,
      resolution: 'last_write_wins',
      winning_change: change as ChangeLogEntry, // Incoming change wins by default
    };
  }

  // Queue changes for offline devices
  private async queueForOfflineDevices(entry: ChangeLogEntry): Promise<void> {
    for (const [deviceId, device] of this.devices.entries()) {
      // Skip the device that made the change
      if (deviceId === entry.device_id) continue;

      // Queue for devices that are behind
      if (device.last_sequence < entry.sequence) {
        const pending = this.pendingChanges.get(deviceId) ?? [];
        pending.push(entry);
        this.pendingChanges.set(deviceId, pending);
      }
    }

    await this.ctx.storage.put('pendingChanges', Array.from(this.pendingChanges.entries()));
  }

  // Handle acknowledgment from device
  private async handleAcknowledgment(deviceId: string, sequence: number): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) return;

    device.last_sequence = sequence;

    // Remove acknowledged changes from pending queue
    const pending = this.pendingChanges.get(deviceId) ?? [];
    const filtered = pending.filter(entry => entry.sequence > sequence);

    if (filtered.length === 0) {
      this.pendingChanges.delete(deviceId);
    } else {
      this.pendingChanges.set(deviceId, filtered);
    }

    await this.persistDevices();
    await this.ctx.storage.put('pendingChanges', Array.from(this.pendingChanges.entries()));
  }

  // Persist devices map to storage
  private async persistDevices(): Promise<void> {
    await this.ctx.storage.put('devices', Array.from(this.devices.entries()));
  }

  // Broadcast message to connected clients (excluding specified device)
  private broadcast(message: Record<string, unknown>, excludeDeviceId?: string): void {
    const payload = JSON.stringify(message);

    for (const session of this.sessions.values()) {
      // Skip excluded device
      if (excludeDeviceId && session.deviceId === excludeDeviceId) continue;

      try {
        session.webSocket.send(payload);
      } catch {
        // WebSocket might be closed, will be cleaned up on next close event
      }
    }
  }

  // Alarm handler for scheduled cleanup/maintenance
  override async alarm(): Promise<void> {
    // Clean up old change log entries older than 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const oldCount = this.changeLog.length;
    this.changeLog = this.changeLog.filter(entry => entry.timestamp > thirtyDaysAgo);

    if (this.changeLog.length < oldCount) {
      await this.ctx.storage.put('changeLog', this.changeLog);
      console.log(`Cleaned up ${oldCount - this.changeLog.length} old change log entries`);
    }

    // Schedule next cleanup in 24 hours
    await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
  }
}
