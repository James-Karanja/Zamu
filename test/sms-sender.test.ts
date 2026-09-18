import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueuedMessage } from '../src/sms/dispatch.ts';
import {
  MissingCredentialsError, africasTalkingSender, chooseSender, credentialsFromEnv, recordingSender,
} from '../src/sms/senders.ts';

const message: QueuedMessage = {
  id: 7,
  eventRef: 'case_event:42',
  phone: '+254700000001',
  language: 'en',
  template: 'smsVerified',
  body: 'Zamu: Ada is verified for 2026 Term 2.',
  caseId: 'ZM-0001',
  roundId: 'R-2026-T2',
  at: '2026-09-18T08:00:00.000Z',
};

const ok = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });

test('the recording sender keeps messages on this machine', async () => {
  const sender = recordingSender();
  const result = await sender.send(message);
  assert.deepEqual(sender.sent, [message]);
  assert.equal(result.providerRef, 'recorded:7');
});

test('the provider request carries the credentials, recipient and body', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const sender = africasTalkingSender({ username: 'sandbox', apiKey: 'key-123', from: 'ZAMU' }, async (url, init) => {
    seen = { url: String(url), init: init! };
    return ok({ SMSMessageData: { Recipients: [{ status: 'Success', messageId: 'ATXid_1' }] } });
  });

  const result = await sender.send(message);
  assert.equal(result.providerRef, 'ATXid_1');
  assert.match(seen!.url, /api\.sandbox\.africastalking\.com\/version1\/messaging$/);
  assert.equal(seen!.init.method, 'POST');
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers.apiKey, 'key-123');
  assert.equal(headers['content-type'], 'application/x-www-form-urlencoded');
  const body = seen!.init.body as URLSearchParams;
  assert.equal(body.get('username'), 'sandbox');
  assert.equal(body.get('to'), '+254700000001');
  assert.equal(body.get('message'), message.body);
  assert.equal(body.get('from'), 'ZAMU');
});

test('a custom base url is honoured and the sender id is optional', async () => {
  let url = '';
  let hasFrom = true;
  const sender = africasTalkingSender({ username: 'u', apiKey: 'k', baseUrl: 'https://example.test/send' }, async (target, init) => {
    url = String(target);
    hasFrom = (init!.body as URLSearchParams).has('from');
    return ok({ SMSMessageData: { Recipients: [{ status: 'Success', messageId: 'id' }] } });
  });
  await sender.send(message);
  assert.equal(url, 'https://example.test/send');
  assert.equal(hasFrom, false);
});

test('an HTTP error is raised with the provider status, not swallowed', async () => {
  const sender = africasTalkingSender({ username: 'u', apiKey: 'k' }, async () =>
    new Response('Unauthorized', { status: 401 }));
  await assert.rejects(() => sender.send(message), /401/);
});

test('a rejected recipient is a failure, even with a 200 response', async () => {
  const sender = africasTalkingSender({ username: 'u', apiKey: 'k' }, async () =>
    ok({ SMSMessageData: { Recipients: [{ status: 'UserInBlacklist' }] } }));
  await assert.rejects(() => sender.send(message), /UserInBlacklist/);
});

test('credentials come from the environment and say what is missing', () => {
  assert.throws(() => credentialsFromEnv({}), MissingCredentialsError);
  assert.throws(() => credentialsFromEnv({ AT_USERNAME: 'u' }), /AT_API_KEY/);
  assert.throws(() => credentialsFromEnv({ AT_API_KEY: 'k' }), /AT_USERNAME/);
  assert.throws(() => credentialsFromEnv({ AT_USERNAME: '  ', AT_API_KEY: 'k' }), /AT_USERNAME/);
  const config = credentialsFromEnv({ AT_USERNAME: 'sandbox', AT_API_KEY: 'key', AT_SENDER_ID: 'ZAMU' });
  assert.deepEqual(config, { username: 'sandbox', apiKey: 'key', baseUrl: undefined, from: 'ZAMU' });
});

test('a recorded message carries no provider configuration', async () => {
  const sender = recordingSender();
  await sender.send(message);
  // The recorded shape is exactly the stored message: nothing about the provider rides along.
  assert.deepEqual(Object.keys(sender.sent[0]).sort(), Object.keys(message).sort());
});

test('the default run records only; --live without credentials refuses', () => {
  assert.equal(chooseSender([], {}).name, 'recording');
  assert.equal(chooseSender(['node', 'run.ts'], { AT_USERNAME: 'u', AT_API_KEY: 'k' }).name, 'recording');
  assert.equal(chooseSender(['--live'], { AT_USERNAME: 'u', AT_API_KEY: 'k' }).name, 'africastalking');
  assert.throws(() => chooseSender(['--live'], {}), MissingCredentialsError);
});

test('an empty recipients list is a failure, not a silent success', async () => {
  const sender = africasTalkingSender({ username: 'u', apiKey: 'k' }, async () =>
    ok({ SMSMessageData: { Message: 'InsufficientBalance', Recipients: [] } }));
  await assert.rejects(() => sender.send(message), /accepted no recipient/);
});

test('a recipient without a success status is a failure', async () => {
  const sender = africasTalkingSender({ username: 'u', apiKey: 'k' }, async () =>
    ok({ SMSMessageData: { Recipients: [{ messageId: 'id' }] } }));
  await assert.rejects(() => sender.send(message), /rejected the message/);
});

test('an unreadable 200 reply is a failure, not a crash', async () => {
  const sender = africasTalkingSender({ username: 'u', apiKey: 'k' }, async () =>
    new Response('<html>captive portal</html>', { status: 200 }));
  await assert.rejects(() => sender.send(message), /unreadable reply/);
});

test('a blank or insecure base url is refused', () => {
  const base = { AT_USERNAME: 'u', AT_API_KEY: 'k' };
  assert.equal(credentialsFromEnv({ ...base, AT_BASE_URL: '   ' }).baseUrl, undefined);
  assert.throws(() => credentialsFromEnv({ ...base, AT_BASE_URL: 'http://insecure.test' }), /https/);
});
