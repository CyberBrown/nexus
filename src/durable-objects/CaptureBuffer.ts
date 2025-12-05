import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/index.ts';

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

const DEFAULT_CONFIG: BufferConfig = {
  maxChunks: 50,
  maxAgeMs: 5000, // 5 seconds
  mergeWindowMs: 2000, // 2 seconds - merge captures within 2s of each other
};

export class CaptureBuffer extends DurableObject<Env> {
  private buffer: BufferedCapture[] = [];
  private config: BufferConfig = DEFAULT_CONFIG;
  private tenantId: string | null = null;
  private flushInProgress = false;
  private nextAlarmTime: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore state from storage
    this.ctx.blockConcurrencyWhile(async () => {
      this.tenantId = await this.ctx.storage.get('tenantId') ?? null;
      this.buffer = await this.ctx.storage.get('buffer') ?? [];
      this.config = await this.ctx.storage.get('config') ?? DEFAULT_CONFIG;

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

    switch (request.method) {
      case 'POST':
        if (path === '/append') {
          return this.handleAppend(request);
        }
        if (path === '/flush') {
          return this.handleFlush(request);
        }
        if (path === '/configure') {
          return this.handleConfigure(request);
        }
        break;
      case 'GET':
        if (path === '/status') {
          return this.handleStatus();
        }
        if (path === '/buffer') {
          return this.handleGetBuffer();
        }
        break;
    }

    return new Response('Not found', { status: 404 });
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
        return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
      }

      // Initialize tenant if not set
      if (!this.tenantId) {
        await this.initialize(tenant_id);
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
      }

      await this.ctx.storage.put('buffer', this.buffer);

      // Check if we should auto-flush
      const shouldFlush = this.shouldAutoFlush(recentCapture || this.buffer[this.buffer.length - 1]);

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
        tenantId: this.tenantId,
        buffer_length: this.buffer.length,
        total_chunks: totalChunks,
        oldest_capture_age_ms: oldestCapture
          ? Date.now() - new Date(oldestCapture.first_chunk_at).getTime()
          : null,
        flush_in_progress: this.flushInProgress,
        next_alarm: this.nextAlarmTime,
        config: this.config,
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
    if (lastChunk.is_final) {
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
        if (result.status === 'fulfilled') {
          flushedIds.add(toFlush[index].id);
        } else {
          console.error('Failed to flush capture:', result.reason);
          // Mark as accumulating again for retry
          toFlush[index].status = 'accumulating';
        }
      });

      // Remove flushed captures from buffer
      this.buffer = this.buffer.filter(c => !flushedIds.has(c.id));
      await this.ctx.storage.put('buffer', this.buffer);

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
    const oldestCapture = this.buffer.length > 0
      ? this.buffer.reduce((oldest, capture) =>
          capture.first_chunk_at < oldest.first_chunk_at ? capture : oldest
        )
      : null;

    if (!oldestCapture) {
      return;
    }

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
}
