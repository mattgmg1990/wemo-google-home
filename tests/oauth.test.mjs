import assert from "node:assert/strict";
import test from "node:test";
import { createOAuth, redirectUri } from "./helpers/oauth.mjs";

const day = 86_400_000;

async function linkAccount(oauth) {
  const code = oauth.tokens.issueToken("auth_code", "test-user", 300, { redirectUri });
  return oauth.exchange({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
}

test("an account link still refreshes after 180 days and years of use", async () => {
  const oauth = createOAuth();
  const initial = await linkAccount(oauth);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.equal(initial.body.expires_in, 3600);
  const token = initial.body.refresh_token;
  assert.equal(oauth.tokens.verifyToken(token, "refresh_token").exp, null);

  for (const elapsed of [180 * day, day, 3650 * day]) {
    oauth.advanceTime(elapsed);
    const refreshed = await oauth.exchange({ grant_type: "refresh_token", refresh_token: token });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.expires_in, 3600);
    assert.equal(refreshed.body.token_type, "Bearer");
    assert.equal(Object.hasOwn(refreshed.body, "refresh_token"), false);
    assert.equal(oauth.tokens.verifyToken(refreshed.body.access_token, "access_token").sub, "test-user");
    oauth.advanceTime(3600_000);
    assert.equal(oauth.tokens.verifyToken(refreshed.body.access_token, "access_token"), null);
  }
});

test("legacy refresh tokens work before their deadline and stay expired afterward", async () => {
  const oauth = createOAuth();
  const token = oauth.tokens.issueToken("refresh_token", "test-user", 180 * day / 1000);
  oauth.advanceTime(180 * day - 1000);
  assert.equal((await oauth.exchange({ grant_type: "refresh_token", refresh_token: token })).status, 200);
  oauth.advanceTime(1000);
  const expired = await oauth.exchange({ grant_type: "refresh_token", refresh_token: token });
  assert.equal(expired.status, 400);
  assert.deepEqual(expired.body, { error: "invalid_grant" });
  oauth.advanceTime(365 * day);
  assert.equal(oauth.tokens.verifyToken(token, "refresh_token"), null);
});

test("authorization codes keep their short lifetime and redirect binding", async () => {
  const oauth = createOAuth();
  const code = oauth.tokens.issueToken("auth_code", "test-user", 300, { redirectUri });
  const wrongRedirect = await oauth.exchange({
    grant_type: "authorization_code", code, redirect_uri: "https://other.example.test/",
  });
  assert.equal(wrongRedirect.status, 400);
  oauth.advanceTime(300_000);
  const expired = await oauth.exchange({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  assert.equal(expired.status, 400);
  assert.deepEqual(expired.body, { error: "invalid_grant" });
});

test("non-expiring refresh tokens still require client credentials, signature and token kind", async () => {
  const oauth = createOAuth();
  const token = oauth.tokens.issueToken("refresh_token", "test-user", null);
  for (const override of [{ client_id: "wrong-client" }, { client_secret: "wrong-secret" }]) {
    const invalidClient = await oauth.exchange({ grant_type: "refresh_token", refresh_token: token, ...override });
    assert.equal(invalidClient.status, 401);
    assert.deepEqual(invalidClient.body, { error: "invalid_client" });
  }
  for (const invalidToken of [
    `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`,
    oauth.tokens.issueToken("access_token", "test-user", 3600),
    oauth.signedPayload({ iss: "another-issuer", exp: null }),
  ]) {
    const rejected = await oauth.exchange({ grant_type: "refresh_token", refresh_token: invalidToken });
    assert.equal(rejected.status, 400);
    assert.deepEqual(rejected.body, { error: "invalid_grant" });
  }
  assert.equal(oauth.tokens.verifyToken(token, "access_token"), null);
});

test("verification rejects missing, nonnumeric or nonfinite expirations for every token kind", () => {
  const oauth = createOAuth();
  for (const kind of ["auth_code", "access_token", "refresh_token"]) {
    for (const exp of [undefined, "9999999999", true, {}, []]) {
      assert.equal(oauth.tokens.verifyToken(oauth.signedPayload({ kind, exp }), kind), null);
    }
    const infinite = oauth.signedPayload({}, `{"iss":"wemo-google-home","kind":"${kind}","sub":"test-user","iat":0,"exp":1e999}`);
    assert.equal(oauth.tokens.verifyToken(infinite, kind), null);
    if (kind !== "refresh_token") {
      assert.equal(oauth.tokens.verifyToken(oauth.signedPayload({ kind, exp: null }), kind), null);
    }
  }
});

test("issuance cannot accidentally create permanent access tokens or authorization codes", () => {
  const oauth = createOAuth();
  for (const kind of ["auth_code", "access_token", "refresh_token"]) {
    for (const lifetime of [undefined, NaN, Infinity, -Infinity, 0, -1]) {
      assert.throws(() => oauth.tokens.issueToken(kind, "test-user", lifetime));
    }
    if (kind !== "refresh_token") {
      assert.throws(() => oauth.tokens.issueToken(kind, "test-user", null));
    }
  }
});
