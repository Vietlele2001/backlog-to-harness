import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import {
  CONFIG,
  verifySignature,
  buildDshPrompt,
  handleWebhookEvent,
  createWebhookServer,
  activeLocks
} from '../tools/webhook-dispatcher.mjs';

describe('DSH Webhook Dispatcher Test Suite', () => {
  const TEST_SECRET = 'my_super_secure_webhook_secret_12345';
  let server;
  let testPort;
  let baseUrl;

  before(async () => {
    // Configure test environment
    CONFIG.secret = TEST_SECRET;
    CONFIG.dryRun = true;
    CONFIG.port = 0; // Use random available port
    activeLocks.clear();

    server = createWebhookServer();
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        testPort = server.address().port;
        baseUrl = `http://127.0.0.1:${testPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    activeLocks.clear();
  });

  describe('1. HMAC SHA-256 Signature Verification', () => {
    const payload = JSON.stringify({ action: 'labeled', test: true });

    test('accepts valid HMAC signature', () => {
      const hmac = crypto.createHmac('sha256', TEST_SECRET).update(payload).digest('hex');
      const sigHeader = `sha256=${hmac}`;

      const res = verifySignature(Buffer.from(payload), sigHeader, TEST_SECRET);
      assert.equal(res.valid, true);
    });

    test('rejects tampered body or invalid signature', () => {
      const tamperedPayload = JSON.stringify({ action: 'labeled', test: false });
      const hmac = crypto.createHmac('sha256', TEST_SECRET).update(tamperedPayload).digest('hex');
      const sigHeader = `sha256=${hmac}`;

      const res = verifySignature(Buffer.from(payload), sigHeader, TEST_SECRET);
      assert.equal(res.valid, false);
      assert.equal(res.error, 'SIGNATURE_MISMATCH');
    });

    test('rejects missing or malformed signature header', () => {
      const res1 = verifySignature(Buffer.from(payload), 'invalid-header', TEST_SECRET);
      assert.equal(res1.valid, false);
      assert.equal(res1.error, 'MISSING_OR_INVALID_SIGNATURE_HEADER');

      const res2 = verifySignature(Buffer.from(payload), undefined, TEST_SECRET);
      assert.equal(res2.valid, false);
      assert.equal(res2.error, 'MISSING_OR_INVALID_SIGNATURE_HEADER');
    });

    test('allows dev mode when secret is empty', () => {
      const res = verifySignature(Buffer.from(payload), 'sha256=anything', '');
      assert.equal(res.valid, true);
      assert.equal(res.warning, 'NO_SECRET_CONFIGURED');
    });
  });

  describe('2. Autonomous DSH Prompt Construction', () => {
    test('builds comprehensive prompt from GitHub Issue', () => {
      const mockIssue = {
        number: 42,
        title: 'Thêm tính năng tự phục hồi CI/CD',
        body: 'DoR: Acceptance tests pass. Architecture: C4 Container Level 2.',
        labels: [{ name: 'type:ci-repair' }, { name: 'status:ready' }]
      };

      const prompt = buildDshPrompt(mockIssue);
      assert.match(prompt, /\[AUTONOMOUS TASK ASSIGNMENT - GITHUB ISSUE #42\]/);
      assert.match(prompt, /Thêm tính năng tự phục hồi CI\/CD/);
      assert.match(prompt, /type:ci-repair, status:ready/);
      assert.match(prompt, /chuẩn C4/);
    });
  });

  describe('3. Event Filtering & Atomic Task Locking Logic', () => {
    test('handles ping event gracefully', async () => {
      const res = await handleWebhookEvent('ping', { zen: 'Keep it logically awesome.' });
      assert.equal(res.status, 200);
      assert.equal(res.message, 'pong');
    });

    test('ignores issues with non-trigger labels', async () => {
      const payload = {
        action: 'labeled',
        label: { name: 'documentation' },
        issue: {
          number: 201,
          labels: [{ name: 'documentation' }]
        }
      };

      const res = await handleWebhookEvent('issues', payload);
      assert.equal(res.status, 200);
      assert.match(res.message, /Ignored: action 'labeled'/);
    });

    test('triggers atomic lock for status:ready label', async () => {
      activeLocks.delete(202);
      const payload = {
        action: 'labeled',
        label: { name: 'status:ready' },
        issue: {
          number: 202,
          title: 'Triển khai Dispatcher',
          body: 'DoR passed',
          labels: [{ name: 'status:ready' }]
        }
      };

      const res = await handleWebhookEvent('issues', payload);
      assert.equal(res.status, 202);
      assert.match(res.message, /Accepted: Issue #202 locked and dispatched/);
      assert.equal(activeLocks.has(202), true);
    });

    test('triggers atomic lock for type:ci-repair label', async () => {
      activeLocks.delete(203);
      const payload = {
        action: 'labeled',
        label: { name: 'type:ci-repair' },
        issue: {
          number: 203,
          title: 'Sửa lỗi CI',
          body: 'Fix pipeline build',
          labels: [{ name: 'type:ci-repair' }]
        }
      };

      const res = await handleWebhookEvent('issues', payload);
      assert.equal(res.status, 202);
      assert.match(res.message, /Accepted: Issue #203 locked and dispatched/);
    });

    test('prevents race conditions with in-memory lock (409 Conflict)', async () => {
      activeLocks.add(204); // Simulate in-flight lock
      const payload = {
        action: 'labeled',
        label: { name: 'status:ready' },
        issue: {
          number: 204,
          labels: [{ name: 'status:ready' }]
        }
      };

      const res = await handleWebhookEvent('issues', payload);
      assert.equal(res.status, 409);
      assert.match(res.message, /could not be locked/);
      activeLocks.delete(204);
    });
  });

  describe('4. HTTP Webhook Server Ingress Endpoints', () => {
    test('GET /health returns healthy status', async () => {
      const res = await fetch(`${baseUrl}/health`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.status, 'healthy');
      assert.equal(data.service, 'dsh-webhook-dispatcher');
    });

    test('POST to unknown route returns 404', async () => {
      const res = await fetch(`${baseUrl}/unknown`, { method: 'POST' });
      assert.equal(res.status, 404);
    });

    test('GET /webhook/github returns 405 Method Not Allowed', async () => {
      const res = await fetch(`${baseUrl}/webhook/github`, { method: 'GET' });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'POST');
    });

    test('POST /webhook/github without signature returns 401', async () => {
      const res = await fetch(`${baseUrl}/webhook/github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'labeled' })
      });
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.match(data.error, /Invalid HMAC/);
    });

    test('POST /webhook/github with invalid JSON returns 400', async () => {
      const raw = 'invalid-json{{{';
      const hmac = crypto.createHmac('sha256', TEST_SECRET).update(raw).digest('hex');

      const res = await fetch(`${baseUrl}/webhook/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': `sha256=${hmac}`
        },
        body: raw
      });
      assert.equal(res.status, 400);
    });

    test('POST /webhook/github with valid signature and status:ready returns 202 Accepted', async () => {
      activeLocks.delete(301);
      const payload = JSON.stringify({
        action: 'labeled',
        label: { name: 'status:ready' },
        issue: {
          number: 301,
          title: 'Feature ticket via Webhook HTTP',
          body: 'Full e2e acceptance criteria',
          labels: [{ name: 'status:ready' }, { name: 'type:story' }]
        }
      });
      const hmac = crypto.createHmac('sha256', TEST_SECRET).update(payload).digest('hex');

      const res = await fetch(`${baseUrl}/webhook/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': `sha256=${hmac}`,
          'X-GitHub-Event': 'issues',
          'X-GitHub-Delivery': 'deliv-test-uuid-001'
        },
        body: payload
      });

      assert.equal(res.status, 202);
      const data = await res.json();
      assert.match(data.message, /Accepted: Issue #301 locked and dispatched/);
      activeLocks.delete(301);
    });
  });
});
