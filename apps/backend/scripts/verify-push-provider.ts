// @ts-nocheck
// scripts/verify-push-provider.ts
//
// Push provider pipeline verification (Node, no DB, no credentials).
// Exercises apps/backend/src/push/provider.ts contract:
//   1. factory picks Mock by default, Expo when EXPO_PUSH_ENABLED=1
//   2. Mock registry refuses non-Expo-shaped tokens (no valid delivery)
//   3. Mock accepts Expo-shaped tokens and records deliveries; reset clears
//   4. ExpoPushProvider short-circuits invalid tokens before any HTTP
//   5. ExpoPushProvider posts the correct payload (title/body/data/sound/
//      channelId) to apiRoot and maps ticket status -> SendResult
//
// Run (from apps/backend):  node --import tsx scripts/verify-push-provider.ts
// or:                       pnpm --filter @wpt/backend exec tsx scripts/verify-push-provider.ts

import * as assert from 'node:assert';
import { createServer } from 'node:http';
import {
  selectPushProvider,
  ExpoPushProvider,
  MockPushProvider,
  mockPushDebug,
} from '../src/push/provider.js';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
  } catch (e) {
    fail += 1;
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
  } catch (e) {
    fail += 1;
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const VALID = 'ExponentPushToken[onb-mock-1a2b3c4d5e6f]';

async function main() {
  // Factory selection
  check('1 mock provider is the default', () => {
    assert.strictEqual(selectPushProvider().constructor.name, 'MockPushProvider');
  });
  check('1b EXPO_PUSH_ENABLED=1 selects the Expo provider', () => {
    const prev = process.env.EXPO_PUSH_ENABLED;
    process.env.EXPO_PUSH_ENABLED = '1';
    try {
      assert.strictEqual(selectPushProvider().constructor.name, 'ExpoPushProvider');
    } finally {
      if (prev === undefined) delete process.env.EXPO_PUSH_ENABLED;
      else process.env.EXPO_PUSH_ENABLED = prev;
    }
  });

  // Mock provider token contract
  await checkAsync('2 mock rejects a raw/non-Expo token', async () => {
    mockPushDebug.reset();
    const provider = new MockPushProvider();
    const out = await provider.send('some-raw-token', { title: 't', body: 'b' });
    assert.deepStrictEqual(out, { ok: false, message: 'TOKEN_INVALID' });
    assert.strictEqual(mockPushDebug.deliveryCount(), 0);
  });
  await checkAsync('3 mock records an Expo-shaped delivery + reset clears', async () => {
    mockPushDebug.reset();
    const provider = new MockPushProvider();
    const out = await provider.send(VALID, { title: 't', body: 'b', channelId: 'messages' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(mockPushDebug.deliveryCount(), 1);
    assert.strictEqual(mockPushDebug.deliveries()[0].token, VALID);
    assert.strictEqual(mockPushDebug.deliveries()[0].title, 't');
    mockPushDebug.reset();
    assert.strictEqual(mockPushDebug.deliveryCount(), 0);
  });

  // Real (Expo) provider path — against a local HTTP server so no credentials
  // are needed, proving the HTTP contract end-to-end.
  await checkAsync('4 Expo provider short-circuits invalid token (no HTTP)', async () => {
    const provider = new ExpoPushProvider();
    const out = await provider.send('raw', { title: 't', body: 'b' });
    assert.deepStrictEqual(out, { ok: false, message: 'TOKEN_INVALID' });
  });

  let lastRequest = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastRequest = { method: req.method, url: req.url, body: JSON.parse(body) };
      res.setHeader('Content-Type', 'application/json');
      if (lastRequest.body[0]?.to.includes('ticket-error')) {
        res.end(JSON.stringify({ data: [{ status: 'error', message: 'DeviceNotRegistered' }] }));
      } else {
        res.end(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-abc123' }] }));
      }
    });
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  try {
    await checkAsync('5 Expo provider POSTs the correct payload shape', async () => {
      const provider = new ExpoPushProvider();
      const out = await provider.send(VALID, {
        title: 'New message',
        body: 'Hello',
        data: { chatId: 'c1' },
        sound: 'default',
        channelId: 'messages',
        apiRoot: `http://127.0.0.1:${port}/--/api/v2/push/send`,
      });
      assert.deepStrictEqual(out, { ok: true, remoteId: 'ticket-abc123' });
      assert.strictEqual(lastRequest.method, 'POST');
      assert.strictEqual(lastRequest.url, '/--/api/v2/push/send');
      assert.strictEqual(lastRequest.body.length, 1);
      const p = lastRequest.body[0];
      assert.strictEqual(p.to, VALID);
      assert.strictEqual(p.title, 'New message');
      assert.strictEqual(p.body, 'Hello');
      assert.deepStrictEqual(p.data, { chatId: 'c1' });
      assert.strictEqual(p.sound, 'default');
      assert.strictEqual(p.channelId, 'messages');
    });
    await checkAsync('6 Expo provider maps a ticket error to failure', async () => {
      const provider = new ExpoPushProvider();
      const out = await provider.send('ExponentPushToken[ticket-error-token]', {
        title: 't',
        body: 'b',
        apiRoot: `http://127.0.0.1:${port}`,
      });
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.message, 'EXPO_TICKET_error');
    });
  } finally {
    server.close();
  }

  console.log(`pass=${pass} fail=${fail}`);
  for (const f of failures) console.log(`FAIL ${f}`);
  if (fail > 0) process.exit(1);
  console.log('ALL PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});