import { describe, it, expect, beforeAll } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import app from '../src/index';
import type { AuthSession } from '../src/durable-objects/UserSession.ts';

describe('UserSession Durable Object (Integration)', () => {
  let authToken: string;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    // Create test tenant and user
    const setupRequest = new Request('http://localhost/setup', {
      method: 'POST',
    });
    const ctx = createExecutionContext();
    const testEnv = { ...env, ENVIRONMENT: 'development' };
    const setupResponse = await app.fetch(setupRequest, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    if (setupResponse.status === 200) {
      const setupData = await setupResponse.json() as {
        data: { token: string; tenant_id: string; user_id: string };
      };
      authToken = setupData.data.token;
      tenantId = setupData.data.tenant_id;
      userId = setupData.data.user_id;
    }
  });

  // Helper to create authenticated request
  function createAuthRequest(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    if (authToken) {
      headers.set('Authorization', `Bearer ${authToken}`);
    }

    return new Request(`http://localhost${path}`, {
      ...options,
      headers,
    });
  }

  describe('Status and Monitoring', () => {
    it.skip('should return session status', async () => {
      const request = createAuthRequest('/api/session/status');
      const ctx = createExecutionContext();
      const response = await app.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const data = await response.json() as {
        success: boolean;
        data: {
          userId: string;
          tenantId: string;
        };
      };
      expect(data.success).toBe(true);
    });
  });

  describe('Device Management', () => {
    it.skip('should register a device', async () => {
      const request = createAuthRequest('/api/session/device/register', {
        method: 'POST',
        body: JSON.stringify({
          deviceName: 'Test Device',
          deviceType: 'mobile',
          platform: 'iOS',
          userAgent: 'TestAgent/1.0',
        }),
      });

      const ctx = createExecutionContext();
      const response = await app.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const data = await response.json() as {
        success: boolean;
        data: { device: { id: string; deviceName: string } };
      };
      expect(data.success).toBe(true);
      expect(data.data.device.deviceName).toBe('Test Device');
    });

    it.skip('should get device list', async () => {
      const request = createAuthRequest('/api/session/devices');
      const ctx = createExecutionContext();
      const response = await app.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const data = await response.json() as {
        success: boolean;
        data: { devices: Array<{ id: string }> };
      };
      expect(data.success).toBe(true);
    });
  });

  describe('Auth Session Lifecycle', () => {
    it.skip('should create a new auth session', async () => {
      const deviceId = crypto.randomUUID();

      const request = createAuthRequest('/api/session/auth/create', {
        method: 'POST',
        body: JSON.stringify({
          device_id: deviceId,
        }),
      });

      const ctx = createExecutionContext();
      const response = await app.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(201);

      const data = await response.json() as { success: boolean; data: { session: AuthSession } };
      expect(data.success).toBe(true);
      expect(data.data.session.id).toBeTruthy();
      expect(data.data.session.tenant_id).toBe(tenantId);
      expect(data.data.session.user_id).toBe(userId);
      expect(data.data.session.device_id).toBe(deviceId);
      expect(data.data.session.status).toBe('active');
    });

    it.skip('should list all auth sessions', async () => {
      const request = createAuthRequest('/api/session/auth/list');
      const ctx = createExecutionContext();
      const response = await app.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const data = await response.json() as {
        success: boolean;
        data: { sessions: AuthSession[]; total: number; active: number };
      };
      expect(data.success).toBe(true);
    });
  });

  describe('User Preferences', () => {
    it.skip('should get user preferences', async () => {
      const request = createAuthRequest('/api/session/preferences');
      const ctx = createExecutionContext();
      const response = await app.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      const data = await response.json() as {
        success: boolean;
        data: { preferences: Record<string, unknown> };
      };
      expect(data.success).toBe(true);
      expect(data.data.preferences).toBeTruthy();
    });
  });
});
