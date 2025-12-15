import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/index.ts';
import { ValidationError } from '../lib/errors.ts';

interface CaptureChunk {
  id: string;
  content: string;
  timestamp: string;
  source_type: 'voice' | 'text';
  is_final?: boolean; // For voice transcription chunks
  metadata?: Record<string, unknown>;
}

interface BufferedCapture {
  id: string;
  tenant_id: string;
  user_id: string;
  chunks: CaptureChunk[];
  source_type: 'voice' | 'text';
  source_platform?: string;
  first_chunk_at: string;
  last_chunk_at: string;
  status: 'accumulating' | 'flushing' | 'flushed';
}

interface BufferConfig {
  maxChunks: number; // Max chunks before auto-flush
  maxAgeMs: number; // Max age in ms before auto-flush
  mergeWindowMs: number; // Time window to merge related captures
}

interface WebSocketSession {
  webSocket: WebSocket;
  userId: string;
  connectedAt: string;
}

interface BufferStats {
  total_buffered: number;
  total_flushed: number;
  total_errors: number;
  last_flush_at: string | null;
  buffer_size_bytes: number;
}

const DEFAULT_CONFIG: BufferConfig = {
  maxChunks: 50,
  maxAgeMs: 5000, // 5 seconds
  mergeWindowMs: 2000, // 2 seconds - merge captures within 2s of each other
};

// Rate limiting constants
const MAX_RATE_PER_MINUTE = 300; // Max 300 captures per minute per tenant
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_BUFFER_SIZE_BYTES = 1024 * 1024; // 1MB max buffer size

export class CaptureBuffer extends DurableObject<Env> {
  private buffer: BufferedCapture[] = [];
  private config: BufferConfig = DEFAULT_CONFIG;
  private tenantId: string | null = null;
  private flushInProgress = false;
  private nextAlarmTime: number | null = null;
  private sessions: Map<string, WebSocketSession> = new Map();
  private stats: BufferStats = {
    total_buffered: 0,
    total_flushed: 0,
    total_errors: 0,
    last_flush_at: null,
    buffer_size_bytes: 0,
  };

  // Rate limiting
  private requestTimestamps: number[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore state from storage
    this.ctx.blockConcurrencyWhile(async () => {
      this.tenantId = await this.ctx.storage.get('tenantId') ?? null;
      this.buffer = await this.ctx.storage.get('buffer') ?? [];
      this.config = await this.ctx.storage.get('config') ?? DEFAULT_CONFIG;
      this.stats = await this.ctx.storage.get('stats') ?? this.stats;

      // Calculate buffer size
      this.calculateBufferSize();

      // Resume alarm if there were buffered items
      if (this.buffer.length > 0) {
        await this.scheduleFlush();
      }
    });
  }

  // Initialize with tenant ID and optional config
  async initialize(tenantId: string, config?: Partial<BufferConfig>): Promise<void> {
    this.tenantId = tenantId;
    await this.ctx.storage.put('tenantId', tenantId);

    if (config) {
      this.config = { ...this.config, ...config };
      await this.ctx.storage.put('config', this.config);
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

    try {
      switch (request.method) {
        case 'POST':
          if (path === '/append' || path === '/buffer') {
            return await this.handleAppend(request);
          }
          if (path === '/flush') {
            return await this.handleFlush(request);
          }
          if (path === '/configure') {
            return await this.handleConfigure(request);
          }
          if (path === '/clear') {
            return await this.handleClear();
          }
          break;
        case 'GET':
          if (path === '/status') {
            return this.handleStatus();
          }
          if (path === '/buffer' || path === '/') {
            return this.handleGetBuffer();
          }
          break;
      }

      return Response.json({ success: false, error: 'Not found' }, { status: 404 });
    } catch (error) {
      console.error('CaptureBuffer error:', error);
      this.stats.total_errors++;

      if (error instanceof ValidationError) {
        return Response.json(
          { success: false, error: error.message, details: error.details },
          { status: error.statusCode }
        );
      }

      return Response.json(
        { success: false, error: 'Internal error' },
        { status: 500 }
      );
    }
  }

  // Handle WebSocket connections for real-time updates
  private async handleWebSocket(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');

    if (!userId) {
      return new Response('Missing userId parameter', { status: 400 });
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
      connectedAt: new Date().toISOString(),
    });

    // Store session ID on the WebSocket for later reference
    (server as unknown as Record<string, string>).__sessionId = sessionId;

    // Send initial state
    server.send(JSON.stringify({
      type: 'connected',
      sessionId,
      bufferSize: this.buffer.length,
      stats: this.stats,
      config: this.config,
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
        case 'get_status':
          ws.send(JSON.stringify({
            type: 'status',
            bufferSize: this.buffer.length,
            stats: this.stats,
            config: this.config,
          }));
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
      this.sessions.delete(sessionId);
    }
    console.log(`CaptureBuffer WebSocket closed with code ${code}`);
  }

  // Append a chunk to the buffer
  private async handleAppend(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        tenant_id: string;
        user_id: string;
        content: string;
        source_type: 'voice' | 'text';
        source_platform?: string;
        is_final?: boolean;
        metadata?: Record<string, unknown>;
      };

      const { tenant_id, user_id, content, source_type, source_platform, is_final, metadata } = body;

      if (!tenant_id || !user_id || !content || !source_type) {
        throw new ValidationError('Missing required fields', [
          { field: 'tenant_id', message: 'Required' },
          { field: 'user_id', message: 'Required' },
          { field: 'content', message: 'Required' },
          { field: 'source_type', message: 'Required' },
        ]);
      }

      // Initialize tenant if not set
      if (!this.tenantId) {
        await this.initialize(tenant_id);
      } else if (this.tenantId !== tenant_id) {
        throw new ValidationError('Tenant ID mismatch');
      }

      // Check rate limiting
      if (!this.checkRateLimit()) {
        return Response.json(
          {
            success: false,
            error: 'Rate limit exceeded',
            code: 'RATE_LIMIT_EXCEEDED',
            retry_after: this.getRateLimitRetryAfter(),
          },
          { status: 429 }
        );
      }

      // Check backpressure - if buffer is too large, reject
      if (this.stats.buffer_size_bytes >= MAX_BUFFER_SIZE_BYTES) {
        return Response.json(
          {
            success: false,
            error: 'Buffer full - backpressure active',
            code: 'BUFFER_FULL',
            buffer_size: this.buffer.length,
            buffer_size_bytes: this.stats.buffer_size_bytes,
          },
          { status: 503 }
        );
      }

      const now = new Date().toISOString();
      const chunk: CaptureChunk = {
        id: crypto.randomUUID(),
        content,
        timestamp: now,
        source_type,
        is_final,
        metadata,
      };

      // Try to find a recent capture to append to (within merge window)
      const recentCapture = this.findRecentCapture(user_id, source_type);

      if (recentCapture && recentCapture.status === 'accumulating') {
        // Append to existing capture
        recentCapture.chunks.push(chunk);
        recentCapture.last_chunk_at = now;
      } else {
        // Create new buffered capture
        const capture: BufferedCapture = {
          id: crypto.randomUUID(),
          tenant_id,
          user_id,
          chunks: [chunk],
          source_type,
          source_platform,
          first_chunk_at: now,
          last_chunk_at: now,
          status: 'accumulating',
        };
        this.buffer.push(capture);
        this.stats.total_buffered++;
      }

      // Recalculate buffer size
      this.calculateBufferSize();

      await this.ctx.storage.put('buffer', this.buffer);
      await this.ctx.storage.put('stats', this.stats);

      // Broadcast to connected clients
      this.broadcast({
        type: 'chunk_buffered',
        chunk_id: chunk.id,
        buffer_size: this.buffer.length,
        buffer_size_bytes: this.stats.buffer_size_bytes,
      }, user_id);

      // Check if we should auto-flush
      const targetCapture = recentCapture || this.buffer[this.buffer.length - 1];
      const shouldFlush = targetCapture ? this.shouldAutoFlush(targetCapture) : false;

      if (shouldFlush) {
        // Flush immediately
        this.flush();
      } else {
        // Schedule flush alarm
        await this.scheduleFlush();
      }

      return Response.json({
        success: true,
        data: {
          chunk_id: chunk.id,
          buffer_length: this.buffer.length,
          total_chunks: this.buffer.reduce((sum, c) => sum + c.chunks.length, 0),
        },
      });
    } catch (error) {
      console.error('Append error:', error);
      return Response.json({ success: false, error: 'Append failed' }, { status: 500 });
    }
  }

  // Force flush the buffer
  private async handleFlush(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        tenant_id?: string;
        user_id?: string;
        capture_id?: string;
      };

      const flushed = await this.flush(body.capture_id, body.user_id);

      return Response.json({
        success: true,
        data: {
          flushed_count: flushed,
          remaining: this.buffer.length,
        },
      });
    } catch (error) {
      console.error('Flush error:', error);
      return Response.json({ success: false, error: 'Flush failed' }, { status: 500 });
    }
  }

  // Configure buffer settings
  private async handleConfigure(request: Request): Promise<Response> {
    try {
      const config = await request.json() as Partial<BufferConfig>;

      this.config = { ...this.config, ...config };
      await this.ctx.storage.put('config', this.config);

      return Response.json({
        success: true,
        data: { config: this.config },
      });
    } catch (error) {
      console.error('Configure error:', error);
      return Response.json({ success: false, error: 'Configuration failed' }, { status: 500 });
    }
  }

  // Get buffer status
  private handleStatus(): Response {
    const oldestCapture = this.buffer.length > 0
      ? this.buffer.reduce((oldest, capture) =>
          capture.first_chunk_at < oldest.first_chunk_at ? capture : oldest
        )
      : null;

    const totalChunks = this.buffer.reduce((sum, c) => sum + c.chunks.length, 0);

    return Response.json({
      success: true,
      data: {
        tenant_id: this.tenantId,
        buffer_length: this.buffer.length,
        total_chunks: totalChunks,
        buffer_size_bytes: this.stats.buffer_size_bytes,
        connected_clients: this.sessions.size,
        oldest_capture_age_ms: oldestCapture
          ? Date.now() - new Date(oldestCapture.first_chunk_at).getTime()
          : null,
        flush_in_progress: this.flushInProgress,
        next_alarm: this.nextAlarmTime,
        stats: this.stats,
        config: this.config,
        rate_limit: {
          max_per_minute: MAX_RATE_PER_MINUTE,
          current_count: this.requestTimestamps.length,
        },
      },
    });
  }

  // Get current buffer contents
  private handleGetBuffer(): Response {
    return Response.json({
      success: true,
      data: {
        buffer: this.buffer.map(capture => ({
          id: capture.id,
          user_id: capture.user_id,
          source_type: capture.source_type,
          chunk_count: capture.chunks.length,
          first_chunk_at: capture.first_chunk_at,
          last_chunk_at: capture.last_chunk_at,
          status: capture.status,
          age_ms: Date.now() - new Date(capture.first_chunk_at).getTime(),
        })),
      },
    });
  }

  // Find recent capture to merge with
  private findRecentCapture(userId: string, sourceType: 'voice' | 'text'): BufferedCapture | null {
    const now = Date.now();
    const mergeWindowMs = this.config.mergeWindowMs;

    // Find the most recent capture for this user and source type within merge window
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const capture = this.buffer[i];
      if (!capture) continue;

      const age = now - new Date(capture.last_chunk_at).getTime();

      if (
        capture.user_id === userId &&
        capture.source_type === sourceType &&
        capture.status === 'accumulating' &&
        age <= mergeWindowMs
      ) {
        return capture;
      }
    }

    return null;
  }

  // Check if capture should trigger auto-flush
  private shouldAutoFlush(capture: BufferedCapture): boolean {
    const now = Date.now();
    const age = now - new Date(capture.first_chunk_at).getTime();

    // Check if buffer is full
    if (capture.chunks.length >= this.config.maxChunks) {
      return true;
    }

    // Check if capture is too old
    if (age >= this.config.maxAgeMs) {
      return true;
    }

    // Check if last chunk was marked as final (for voice)
    const lastChunk = capture.chunks[capture.chunks.length - 1];
    if (lastChunk && lastChunk.is_final) {
      return true;
    }

    return false;
  }

  // Flush buffer to InboxManager
  private async flush(captureId?: string, userId?: string): Promise<number> {
    if (this.flushInProgress) {
      return 0;
    }

    this.flushInProgress = true;

    try {
      // Filter captures to flush
      let toFlush: BufferedCapture[];

      if (captureId) {
        toFlush = this.buffer.filter(c => c.id === captureId);
      } else if (userId) {
        toFlush = this.buffer.filter(c => c.user_id === userId);
      } else {
        toFlush = [...this.buffer];
      }

      if (toFlush.length === 0) {
        return 0;
      }

      // Mark as flushing
      toFlush.forEach(capture => {
        capture.status = 'flushing';
      });
      await this.ctx.storage.put('buffer', this.buffer);

      // Get InboxManager DO stub
      const inboxManagerId = this.env.INBOX_MANAGER.idFromName(this.tenantId!);
      const inboxManager = this.env.INBOX_MANAGER.get(inboxManagerId);

      // Send each capture to InboxManager
      const results = await Promise.allSettled(
        toFlush.map(async (capture) => {
          // Merge all chunks into a single content string
          const mergedContent = capture.chunks
            .map(chunk => chunk.content)
            .join(' ')
            .trim();

          // Prepare metadata
          const metadata = {
            capture_buffer_id: capture.id,
            chunk_count: capture.chunks.length,
            first_chunk_at: capture.first_chunk_at,
            last_chunk_at: capture.last_chunk_at,
            chunks: capture.chunks.map(c => ({
              id: c.id,
              timestamp: c.timestamp,
              is_final: c.is_final,
            })),
          };

          // Send to InboxManager
          const response = await inboxManager.fetch('https://inbox-manager/capture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tenant_id: capture.tenant_id,
              user_id: capture.user_id,
              input: {
                source_type: capture.source_type,
                source_platform: capture.source_platform,
                source_id: capture.id,
                raw_content: mergedContent,
                captured_at: capture.first_chunk_at,
                metadata,
              },
            }),
          });

          if (!response.ok) {
            throw new Error(`InboxManager returned ${response.status}`);
          }

          return capture.id;
        })
      );

      // Remove successfully flushed captures
      const flushedIds = new Set<string>();
      results.forEach((result, index) => {
        const capture = toFlush[index];
        if (!capture) return;

        if (result.status === 'fulfilled') {
          flushedIds.add(capture.id);
        } else {
          console.error('Failed to flush capture:', result.reason);
          // Mark as accumulating again for retry
          capture.status = 'accumulating';
        }
      });

      // Remove flushed captures from buffer
      this.buffer = this.buffer.filter(c => !flushedIds.has(c.id));

      // Update stats
      this.stats.total_flushed += flushedIds.size;
      this.stats.last_flush_at = new Date().toISOString();
      this.calculateBufferSize();

      await this.ctx.storage.put('buffer', this.buffer);
      await this.ctx.storage.put('stats', this.stats);

      // Broadcast flush event
      this.broadcast({
        type: 'buffer_flushed',
        flushed_count: flushedIds.size,
        remaining: this.buffer.length,
        stats: this.stats,
      });

      // Reschedule alarm if buffer still has items
      if (this.buffer.length > 0) {
        await this.scheduleFlush();
      } else {
        // Clear alarm if buffer is empty
        await this.ctx.storage.deleteAlarm();
        this.nextAlarmTime = null;
      }

      return flushedIds.size;
    } finally {
      this.flushInProgress = false;
    }
  }

  // Schedule alarm for automatic flush
  private async scheduleFlush(): Promise<void> {
    const now = Date.now();

    // Find oldest capture age
    if (this.buffer.length === 0) {
      return;
    }

    const firstCapture = this.buffer[0];
    if (!firstCapture) {
      return;
    }

    const oldestCapture = this.buffer.reduce((oldest, capture) =>
      capture.first_chunk_at < oldest.first_chunk_at ? capture : oldest
    , firstCapture);

    const captureAge = now - new Date(oldestCapture.first_chunk_at).getTime();
    const timeUntilFlush = Math.max(0, this.config.maxAgeMs - captureAge);

    // Schedule alarm (add 100ms buffer to ensure we're past maxAgeMs)
    const alarmTime = now + timeUntilFlush + 100;

    // Only reschedule if this is sooner than current alarm
    if (!this.nextAlarmTime || alarmTime < this.nextAlarmTime) {
      await this.ctx.storage.setAlarm(alarmTime);
      this.nextAlarmTime = alarmTime;
    }
  }

  // Alarm handler for automatic flush
  override async alarm(): Promise<void> {
    this.nextAlarmTime = null;

    // Find captures that need flushing
    const now = Date.now();
    const capturesToFlush = this.buffer.filter(capture => {
      const age = now - new Date(capture.first_chunk_at).getTime();
      return age >= this.config.maxAgeMs || this.shouldAutoFlush(capture);
    });

    if (capturesToFlush.length > 0) {
      // Flush all old captures
      await Promise.all(
        capturesToFlush.map(capture => this.flush(capture.id))
      );
    }

    // Reschedule if more captures remain
    if (this.buffer.length > 0) {
      await this.scheduleFlush();
    }
  }

  // Handle clear buffer request
  private async handleClear(): Promise<Response> {
    const clearedCount = this.buffer.length;

    this.buffer = [];
    this.stats.buffer_size_bytes = 0;

    if (this.nextAlarmTime) {
      await this.ctx.storage.deleteAlarm();
      this.nextAlarmTime = null;
    }

    await this.ctx.storage.put('buffer', this.buffer);
    await this.ctx.storage.put('stats', this.stats);

    this.broadcast({
      type: 'buffer_cleared',
      count: clearedCount,
    });

    return Response.json({
      success: true,
      data: { cleared_count: clearedCount },
    });
  }

  // Rate limiting logic
  private checkRateLimit(): boolean {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;

    // Remove old timestamps outside the window
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > windowStart);

    // Check if we're over the limit
    if (this.requestTimestamps.length >= MAX_RATE_PER_MINUTE) {
      return false;
    }

    // Add current request timestamp
    this.requestTimestamps.push(now);
    return true;
  }

  // Get retry-after time in seconds for rate limiting
  private getRateLimitRetryAfter(): number {
    if (this.requestTimestamps.length === 0) return 0;

    const oldestTimestamp = this.requestTimestamps[0];
    if (!oldestTimestamp) return 0;

    const retryAfterMs = RATE_LIMIT_WINDOW_MS - (Date.now() - oldestTimestamp);

    return Math.ceil(retryAfterMs / 1000);
  }

  // Calculate buffer size in bytes
  private calculateBufferSize(): void {
    this.stats.buffer_size_bytes = this.buffer.reduce((sum, capture) => {
      const captureSize = JSON.stringify(capture).length;
      return sum + captureSize;
    }, 0);
  }

  // Broadcast message to connected clients
  private broadcast(message: Record<string, unknown>, userId?: string): void {
    const payload = JSON.stringify(message);

    for (const session of this.sessions.values()) {
      // If userId specified, only send to that user's sessions
      if (userId && session.userId !== userId) continue;

      try {
        session.webSocket.send(payload);
      } catch {
        // WebSocket might be closed, will be cleaned up on next close event
      }
    }
  }
}
