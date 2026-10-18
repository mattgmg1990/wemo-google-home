import assert from 'node:assert/strict';
import test from 'node:test';
import { createOAuth, redirectUri } from './helpers/oauth.mjs';

const noStore = (response) => assert.equal(response.headers.get('cache-control'), 'no-store');

test('configured login preserves credential acceptance, redirect binding, subject and no-store', async () => {
  const auth = createOAuth();
  const response = await auth.authorize({ state: 'preserve-me' });
  assert.equal(response.status, 303);
  noStore(response);
  const location = new URL(response.headers.get('location'));
  assert.equal(`${location.origin}${location.pathname}`, redirectUri);
  assert.equal(location.searchParams.get('state'), 'preserve-me');
  const code = auth.tokens.verifyToken(location.searchParams.get('code'), 'auth_code');
  assert.equal(code.sub, 'test-user');
  assert.equal(code.redirectUri, redirectUri);
});

test('missing OAuth configuration fails closed before credential or token exchange', async () => {
  for (const field of ['APP_SECRET', 'APP_LOGIN_USERNAME', 'APP_LOGIN_PASSWORD', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) {
    const auth = createOAuth();
    delete auth.env[field];
    const login = await auth.authorize();
    noStore(login);
    assert.equal(new URL(login.headers.get('location')).searchParams.get('error'), 'bridge_not_configured');
    const token = await auth.exchange({ grant_type: 'refresh_token', refresh_token: 'irrelevant' });
    assert.equal(token.status, 503);
    noStore(token);
    assert.deepEqual(token.body, { error: 'service_unavailable' });
  }
});

test('login rejects unapproved clients and redirect URLs without redirecting credentials', async () => {
  const auth = createOAuth();
  for (const fields of [{ client_id: 'other' }, { redirect_uri: 'https://attacker.example/callback' }, { response_type: 'token' }]) {
    const response = await auth.authorize(fields);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
    noStore(response);
  }
});

test('five failed logins throttle even correct credentials until the window expires', async () => {
  const auth = createOAuth();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await auth.authorize({ password: 'incorrect' });
    noStore(response);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), attempt < 5 ? 'invalid_login' : 'rate_limited');
  }
  const blocked = await auth.authorize();
  assert.equal(new URL(blocked.headers.get('location')).searchParams.get('error'), 'rate_limited');
  assert.equal(blocked.headers.get('retry-after'), '900');
  auth.advanceTime(15 * 60 * 1000);
  assert.ok(new URL((await auth.authorize()).headers.get('location')).searchParams.get('code'));
});

test('fulfillment rejects validly signed access tokens for another subject', async () => {
  const auth = createOAuth();
  for (const token of [undefined, auth.tokens.issueToken('access_token', 'another-user', 3600), auth.tokens.issueToken('refresh_token', 'test-user', null)]) {
    const response = await auth.fulfill(token);
    assert.equal(response.status, 401);
    noStore(response);
  }
  const valid = await auth.fulfill(auth.tokens.issueToken('access_token', 'test-user', 3600));
  assert.equal(valid.status, 200);
  noStore(valid);
  assert.equal((await valid.json()).payload.devices.length, 3);
});

test('fulfillment requires the production Pi contract and rejects non-HTTPS production endpoints', async () => {
  for (const field of ['PI_WEBHOOK_URL', 'PI_WEBHOOK_TOKEN', 'GOOGLE_AGENT_USER_ID']) {
    const auth = createOAuth();
    delete auth.env[field];
    const response = await auth.fulfill(auth.tokens.issueToken('access_token', 'test-user', 3600));
    assert.equal(response.status, 503);
    noStore(response);
  }
  const auth = createOAuth();
  auth.env.NODE_ENV = 'production';
  auth.env.PI_WEBHOOK_URL = 'http://localhost/remote.php';
  const response = await auth.fulfill(auth.tokens.issueToken('access_token', 'test-user', 3600));
  assert.equal(response.status, 503);
  noStore(response);
});
