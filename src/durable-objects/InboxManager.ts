import { DurableObject } from 'cloudflare:workers';
import type { Env, ClassificationResult } from '../types/index.ts';
import { getEncryptionKey, encryptField } from '../lib/encryption.ts';
import { classifyInboxItem } from '../lib/classifier.ts';

interface InboxInput {
  source_type: 'voice' | 'email' | 'webhook' | 'manual' | 'sms';
  source_platform?: string;
  source_id?: string;
  raw_content: string;
  captured_at?: string;
  metadata?: Record<string, unknown>;
}

interface QueuedItem {
  id: string;
  tenant_id: string;
  user_id: string;
  input: InboxInput;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: string;
  error?: string;
}

interface WebSocketSession {
  webSocket: WebSocket;
  userId: string;
  connectedAt: string;
}

const AUTO_CREATE_TASK_THRESHOLD = 0.8;

export class InboxManager extends DurableObject<Env> {
  private sessions: Map<string, WebSocketSession> = new Map();
  private classificationQueue: QueuedItem[] = [];
  private tenantId: string | null = null;
  private processing = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Restore state from storage
    this.ctx.blockConcurrencyWhile(async () => {
      this.tenantId = await this.ctx.storage.get('tenantId') ?? null;
      this.classificationQueue = await this.ctx.storage.get('queue') ?? [];
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
        if (path === '/capture') {
          return this.handleCapture(request);
        }
        if (path === '/batch') {
          return this.handleBatchCapture(request);
        }
        break;
      case 'GET':
        if (path === '/status') {
          return this.handleStatus();
        }
        if (path === '/queue') {
          return this.handleQueueStatus();
        }
        break;
    }

    return new Response('Not found', { status: 404 });
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
      queueLength: this.classificationQueue.length,
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
    console.log(`WebSocket closed with code ${code}`);
  }

  // Capture a single input item
  private async handleCapture(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        tenant_id: string;
        user_id: string;
        input: InboxInput;
      };

      const { tenant_id, user_id, input } = body;

      if (!tenant_id || !user_id || !input?.raw_content) {
        return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
      }

      // Initialize tenant if not set
      if (!this.tenantId) {
        await this.initialize(tenant_id);
      }

      const item = await this.queueItem(tenant_id, user_id, input);

      // Broadcast to connected clients
      this.broadcast({
        type: 'item_captured',
        item: { id: item.id, source_type: input.source_type, status: 'pending' },
      }, user_id);

      // Process queue
      this.processQueue();

      return Response.json({ success: true, data: { id: item.id } });
    } catch (error) {
      console.error('Capture error:', error);
      return Response.json({ success: false, error: 'Capture failed' }, { status: 500 });
    }
  }

  // Capture multiple items at once
  private async handleBatchCapture(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        tenant_id: string;
        user_id: string;
        inputs: InboxInput[];
      };

      const { tenant_id, user_id, inputs } = body;

      if (!tenant_id || !user_id || !Array.isArray(inputs)) {
        return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
      }

      if (!this.tenantId) {
        await this.initialize(tenant_id);
      }

      const items = await Promise.all(
        inputs.map(input => this.queueItem(tenant_id, user_id, input))
      );

      this.broadcast({
        type: 'batch_captured',
        count: items.length,
        ids: items.map(i => i.id),
      }, user_id);

      this.processQueue();

      return Response.json({ success: true, data: { ids: items.map(i => i.id) } });
    } catch (error) {
      console.error('Batch capture error:', error);
      return Response.json({ success: false, error: 'Batch capture failed' }, { status: 500 });
    }
  }

  // Get DO status
  private handleStatus(): Response {
    return Response.json({
      success: true,
      data: {
        tenantId: this.tenantId,
        connectedClients: this.sessions.size,
        queueLength: this.classificationQueue.length,
        processing: this.processing,
      },
    });
  }

  // Get queue status
  private handleQueueStatus(): Response {
    return Response.json({
      success: true,
      data: {
        queue: this.classificationQueue.map(item => ({
          id: item.id,
          source_type: item.input.source_type,
          status: item.status,
          created_at: item.created_at,
        })),
      },
    });
  }

  // Queue an item for processing
  private async queueItem(tenantId: string, userId: string, input: InboxInput): Promise<QueuedItem> {
    const item: QueuedItem = {
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      user_id: userId,
      input: {
        ...input,
        captured_at: input.captured_at ?? new Date().toISOString(),
      },
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    this.classificationQueue.push(item);
    await this.ctx.storage.put('queue', this.classificationQueue);

    return item;
  }

  // Process the classification queue
  private async processQueue(): Promise<void> {
    if (this.processing || this.classificationQueue.length === 0) {
      return;
    }

    this.processing = true;

    try {
      while (this.classificationQueue.length > 0) {
        const item = this.classificationQueue.find(i => i.status === 'pending');
        if (!item) break;

        item.status = 'processing';
        await this.ctx.storage.put('queue', this.classificationQueue);

        try {
          // Store to D1
          await this.storeToD1(item);

          // Broadcast that we're classifying
          this.broadcast({
            type: 'item_classifying',
            id: item.id,
          }, item.user_id);

          // Run AI classification
          let classification: ClassificationResult | null = null;
          let taskId: string | null = null;

          try {
            classification = await classifyInboxItem(
              {
                raw_content: item.input.raw_content,
                source_type: item.input.source_type,
                source_platform: item.input.source_platform,
                captured_at: item.input.captured_at!,
              },
              this.env,
              item.tenant_id,
              item.user_id
            );

            // Update inbox_item with classification
            await this.updateInboxItemClassification(item.id, item.tenant_id, classification);

            // Auto-create task if high confidence task classification
            if (
              classification.type === 'task' &&
              classification.confidence_score >= AUTO_CREATE_TASK_THRESHOLD
            ) {
              taskId = await this.createTaskFromClassification(
                item.id,
                item.tenant_id,
                item.user_id,
                classification
              );
            }
          } catch (classifyError) {
            console.error('Classification error:', classifyError);
            // Continue without classification - item is still stored
          }

          item.status = 'completed';

          // Broadcast completion with classification results
          this.broadcast({
            type: 'item_processed',
            id: item.id,
            status: 'completed',
            classification: classification ? {
              type: classification.type,
              title: classification.title,
              domain: classification.domain,
              urgency: classification.urgency,
              importance: classification.importance,
              due_date: classification.due_date,
              due_time: classification.due_time,
              contexts: classification.contexts,
              confidence_score: classification.confidence_score,
            } : null,
            task_created: taskId ? { id: taskId } : null,
          }, item.user_id);

          // Remove from queue
          const index = this.classificationQueue.indexOf(item);
          if (index > -1) {
            this.classificationQueue.splice(index, 1);
          }
        } catch (error) {
          item.status = 'failed';
          item.error = error instanceof Error ? error.message : 'Unknown error';

          this.broadcast({
            type: 'item_failed',
            id: item.id,
            error: item.error,
          }, item.user_id);
        }

        await this.ctx.storage.put('queue', this.classificationQueue);
      }
    } finally {
      this.processing = false;
    }
  }

  // Store item to D1 database
  private async storeToD1(item: QueuedItem): Promise<void> {
    const now = new Date().toISOString();

    // Get encryption key and encrypt sensitive fields
    const key = await getEncryptionKey(this.env.KV, item.tenant_id);
    const encryptedContent = await encryptField(item.input.raw_content, key);

    await this.env.DB.prepare(`
      INSERT INTO inbox_items (
        id, tenant_id, user_id, source_type, source_id, source_platform,
        raw_content, status, captured_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      item.id,
      item.tenant_id,
      item.user_id,
      item.input.source_type,
      item.input.source_id ?? null,
      item.input.source_platform ?? null,
      encryptedContent,
      'pending',
      item.input.captured_at,
      now,
      now
    ).run();
  }

  // Update inbox item with classification results
  private async updateInboxItemClassification(
    itemId: string,
    tenantId: string,
    classification: ClassificationResult
  ): Promise<void> {
    const now = new Date().toISOString();

    await this.env.DB.prepare(`
      UPDATE inbox_items
      SET ai_classification = ?,
          confidence_score = ?,
          status = 'processed',
          processed_at = ?,
          updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).bind(
      JSON.stringify(classification),
      classification.confidence_score,
      now,
      now,
      itemId,
      tenantId
    ).run();
  }

  // Create a task from classification
  private async createTaskFromClassification(
    inboxItemId: string,
    tenantId: string,
    userId: string,
    classification: ClassificationResult
  ): Promise<string> {
    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Get encryption key and encrypt sensitive fields
    const key = await getEncryptionKey(this.env.KV, tenantId);
    const encryptedTitle = await encryptField(classification.title, key);
    const encryptedDescription = classification.description
      ? await encryptField(classification.description, key)
      : null;

    await this.env.DB.prepare(`
      INSERT INTO tasks (
        id, tenant_id, user_id, title, description,
        project_id, domain, contexts, due_date, due_time,
        urgency, importance, status,
        source_type, source_inbox_item_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      taskId,
      tenantId,
      userId,
      encryptedTitle,
      encryptedDescription,
      classification.project_id,
      classification.domain,
      classification.contexts.length > 0 ? JSON.stringify(classification.contexts) : null,
      classification.due_date,
      classification.due_time,
      classification.urgency,
      classification.importance,
      'inbox', // New tasks go to inbox for review
      'ai_classification',
      inboxItemId,
      now,
      now
    ).run();

    // Update inbox item to link to created task
    await this.env.DB.prepare(`
      UPDATE inbox_items
      SET promoted_to_type = 'task',
          promoted_to_id = ?,
          updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).bind(taskId, now, inboxItemId, tenantId).run();

    return taskId;
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

  // Alarm handler for scheduled processing
  override async alarm(): Promise<void> {
    await this.processQueue();
  }
}
