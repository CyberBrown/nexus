import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('CaptureBuffer Durable Object', () => {
  const tenantId = 'test-tenant-123';
  const userId = 'test-user-456';

  // Helper to get a clean buffer instance
  function getBufferStub() {
    const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}:${Date.now()}`);
    return env.CAPTURE_BUFFER.get(id);
  }

  describe('Initialization', () => {
    it('should initialize with tenant ID', async () => {
      const stub = getBufferStub();

      // First append initializes
      await stub.fetch(new Request('http://test/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          user_id: userId,
          content: 'init',
          source_type: 'voice',
        }),
      }));

      const response = await stub.fetch(new Request('http://test/status'));
      const result = await response.json() as any;

      expect(result.success).toBe(true);
      expect(result.data.tenant_id).toBe(tenantId);
    });

    it('should support custom configuration', async () => {
      const stub = getBufferStub();

      const configResponse = await stub.fetch(new Request('http://test/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxChunks: 100,
          maxAgeMs: 10000,
          mergeWindowMs: 3000,
        }),
      }));

      const configResult = await configResponse.json() as any;
      expect(configResult.success).toBe(true);
      expect(configResult.data.config.maxChunks).toBe(100);
      expect(configResult.data.config.maxAgeMs).toBe(10000);
    });
  });

  describe('Buffer Operations', () => {
    it('should buffer a voice chunk', async () => {
      const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
      const stub = env.CAPTURE_BUFFER.get(id);

      const response = await stub.fetch(new Request('http://test/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          user_id: userId,
          content: 'Test voice capture',
          source_type: 'voice',
          source_platform: 'android',
        }),
      }));

      const result = await response.json() as any;
      expect(result.success).toBe(true);
      expect(result.data.buffer_length).toBeGreaterThan(0);
    });

    it('should merge chunks within merge window', async () => {
      const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
      const stub = env.CAPTURE_BUFFER.get(id);

      // First chunk
      await stub.fetch(new Request('http://test/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          user_id: userId,
          content: 'First chunk',
          source_type: 'voice',
        }),
      }));

      // Second chunk (should merge)
      await stub.fetch(new Request('http://test/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          user_id: userId,
          content: 'Second chunk',
          source_type: 'voice',
        }),
      }));

      // Get buffer status
      const statusResponse = await stub.fetch(new Request('http://test/buffer'));
      const statusResult = await statusResponse.json() as any;

      // Should have 1 capture with 2 chunks
      expect(statusResult.success).toBe(true);
      expect(statusResult.data.buffer.length).toBe(1);
      expect(statusResult.data.buffer[0].chunk_count).toBe(2);
    });

    it('should flush buffer manually', async () => {
      const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
      const stub = env.CAPTURE_BUFFER.get(id);

      // Add a chunk
      await stub.fetch(new Request('http://test/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          user_id: userId,
          content: 'Test flush',
          source_type: 'voice',
          is_final: false,
        }),
      }));

      // Flush manually
      const flushResponse = await stub.fetch(new Request('http://test/flush', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }));

      const flushResult = await flushResponse.json() as any;
      expect(flushResult.success).toBe(true);
      expect(flushResult.data.flushed_count).toBeGreaterThan(0);
    });

    it('should clear buffer', async () => {
      const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
      const stub = env.CAPTURE_BUFFER.get(id);

      // Add chunks
      await stub.fetch(new Request('http://test/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          user_id: userId,
          content: 'Test clear',
          source_type: 'voice',
        }),
      }));

      // Clear
      const clearResponse = await stub.fetch(new Request('http://test/clear', {
        method: 'POST',
      }));

      const clearResult = await clearResponse.json() as any;
      expect(clearResult.success).toBe(true);

      // Verify buffer is empty
      const statusResponse = await stub.fetch(new Request('http://test/status'));
      const statusResult = await statusResponse.json() as any;
      expect(statusResult.data.buffer_length).toBe(0);
    });
  });

  describe('Validation', () => {
    it('should reject missing required fields', async () => {
      const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
      const stub = env.CAPTURE_BUFFER.get(id);

      const response = await stub.fetch(new Request('http://test/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Missing required fields
          tenant_id: tenantId,
        }),
      }));

      expect(response.status).toBe(400);
      const result = await response.json() as any;
      expect(result.success).toBe(false);
    });

    it('should reject tenant ID mismatch', async () => {
      const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
      const stub = env.CAPTURE_BUFFER.get(id);

      // Initialize with one tenant
      await stub.fetch(new Request('http://test/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          user_id: userId,
          content: 'Test',
          source_type: 'voice',
        }),
      }));

      // Try different tenant
      const response = await stub.fetch(new Request('http://test/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'different-tenant',
          user_id: userId,
          content: 'Test',
          source_type: 'voice',
        }),
      }));

      expect(response.status).toBe(400);
    });
  });

  describe('Rate Limiting', () => {
    it('should enforce rate limits', async () => {
      const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
      const stub = env.CAPTURE_BUFFER.get(id);

      // Send many requests rapidly
      const promises = [];
      for (let i = 0; i < 350; i++) {
        promises.push(
          stub.fetch(new Request('http://test/append', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tenant_id: tenantId,
              user_id: userId,
              content: `Chunk ${i}`,
              source_type: 'voice',
            }),
          }))
        );
      }

      const responses = await Promise.all(promises);
      const rateLimitedResponses = responses.filter(r => r.status === 429);

      // Should have some rate limited responses
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });
  });

  describe('Backpressure', () => {
    it('should reject when buffer is full', async () => {
      const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
      const stub = env.CAPTURE_BUFFER.get(id);

      // Fill buffer with large chunks
      const largeContent = 'x'.repeat(100000); // 100KB
      const promises = [];

      for (let i = 0; i < 15; i++) {
        promises.push(
          stub.fetch(new Request('http://test/append', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tenant_id: tenantId,
              user_id: userId,
              content: largeContent,
              source_type: 'voice',
            }),
          }))
        );
      }

      const responses = await Promise.all(promises);
      const backpressureResponses = responses.filter(r => r.status === 503);

      // Should have some backpressure responses
      expect(backpressureResponses.length).toBeGreaterThan(0);
    });
  });

  describe('Status and Monitoring', () => {
    it('should return status information', async () => {
      const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
      const stub = env.CAPTURE_BUFFER.get(id);

      const response = await stub.fetch(new Request('http://test/status'));
      const result = await response.json() as any;

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('tenant_id');
      expect(result.data).toHaveProperty('buffer_length');
      expect(result.data).toHaveProperty('buffer_size_bytes');
      expect(result.data).toHaveProperty('stats');
      expect(result.data).toHaveProperty('config');
      expect(result.data).toHaveProperty('rate_limit');
    });

    it('should track statistics', async () => {
      const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
      const stub = env.CAPTURE_BUFFER.get(id);

      // Add some chunks
      for (let i = 0; i < 3; i++) {
        await stub.fetch(new Request('http://test/append', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenant_id: tenantId,
            user_id: userId,
            content: `Chunk ${i}`,
            source_type: 'voice',
          }),
        }));
      }

      const response = await stub.fetch(new Request('http://test/status'));
      const result = await response.json() as any;

      expect(result.data.stats.total_buffered).toBeGreaterThanOrEqual(3);
      expect(result.data.buffer_size_bytes).toBeGreaterThan(0);
    });
  });

  describe('WebSocket Support', () => {
    it('should accept WebSocket connections', async () => {
      const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
      const stub = env.CAPTURE_BUFFER.get(id);

      const response = await stub.fetch(new Request(`http://test/ws?userId=${userId}`, {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
        },
      }));

      expect(response.status).toBe(101);
    });

    it('should reject WebSocket without userId', async () => {
      const id = env.CAPTURE_BUFFER.idFromName(`${tenantId}:${userId}`);
      const stub = env.CAPTURE_BUFFER.get(id);

      const response = await stub.fetch(new Request('http://test/ws', {
        headers: {
          'Upgrade': 'websocket',
          'Connection': 'Upgrade',
        },
      }));

      expect(response.status).toBe(400);
    });
  });
});
