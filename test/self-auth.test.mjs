// The developer's own sign-in from the admin screen: magiclink refuses /auth/send-code
// without a solved puzzle. No database needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { magicLinkClient, solveChallenge } from '../server/magiclink.js';

const puzzle = (number = 777) => {
  const salt = `${randomBytes(6).toString('hex')}?expires=9999999999`;
  return { salt, challenge: createHash('sha256').update(salt + number).digest('hex'), maxnumber: 20000, signature: 'sig' };
};

test('solveChallenge finds the number and keeps what magiclink needs back', () => {
  const p = puzzle();
  assert.deepEqual(JSON.parse(Buffer.from(solveChallenge(p), 'base64')), { salt: p.salt, number: 777, challenge: p.challenge, signature: 'sig' });
});

test('solveChallenge says so when there is no answer', () => {
  assert.throws(() => solveChallenge({ ...puzzle(), challenge: 'nope', maxnumber: 5 }), /no answer/);
});

test('selfSend fetches a puzzle and sends the solved token', async () => {
  const p = puzzle(); const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body && JSON.parse(opts.body) });
    return new Response(JSON.stringify(url.endsWith('/auth/challenge') ? p : { ok: true }), { status: 200 });
  };
  await magicLinkClient('http://ml', fetchImpl).selfSend('dev@example.com');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['GET http://ml/auth/challenge', 'POST http://ml/auth/send-code']);
  assert.equal(calls[1].body.email, 'dev@example.com');
  assert.equal(JSON.parse(Buffer.from(calls[1].body.captcha_token, 'base64')).number, 777);
});
