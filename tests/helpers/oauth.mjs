import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const nativeRequire = createRequire(import.meta.url);
const testSecret = "oauth-regression-test-only-secret";
export const redirectUri = "https://oauth-redirect.googleusercontent.com/r/test-project";

// Like the bridge harness, execute the real TypeScript in isolation with a fake
// clock and environment. Nothing reads real credentials or makes network calls.
export function createOAuth() {
  let now = Date.parse("2026-03-15T17:15:36Z");
  const context = vm.createContext({
    Buffer, Headers, URL,
    Date: class extends Date { static now() { return now; } },
    process: { env: {
      APP_SECRET: testSecret,
      APP_LOGIN_USERNAME: "test-user",
      APP_LOGIN_PASSWORD: "test-password",
      GOOGLE_OAUTH_CLIENT_ID: "test-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
      GOOGLE_REDIRECT_URI: redirectUri,
    } },
  });
  const modules = new Map();
  function loadModule(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const loadedModule = { exports: {} };
    modules.set(filename, loadedModule);
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      fileName: filename,
    });
    const require = (specifier) => specifier.startsWith("@/")
      ? loadModule(path.join(repositoryRoot, "src", `${specifier.slice(2)}.ts`))
      : nativeRequire(specifier);
    const run = new vm.Script(`(function(exports, require, module) {${outputText}\n})`, { filename });
    run.runInContext(context)(loadedModule.exports, require, loadedModule);
    return loadedModule.exports;
  }
  const tokens = loadModule(path.join(repositoryRoot, "src/lib/tokens.ts"));
  const endpoint = loadModule(path.join(repositoryRoot, "src/app/api/oauth/token/route.ts"));
  return {
    tokens,
    advanceTime(milliseconds) { now += milliseconds; },
    signedPayload(overrides = {}, rawPayload) {
      const payload = Buffer.from(rawPayload ?? JSON.stringify({
        exp: Math.floor(now / 1000) + 3600,
        iat: Math.floor(now / 1000),
        iss: "wemo-google-home",
        kind: "refresh_token",
        sub: "test-user",
        ...overrides,
      })).toString("base64url");
      return `${payload}.${createHmac("sha256", testSecret).update(payload).digest("base64url")}`;
    },
    async exchange(fields) {
      const response = await endpoint.POST(new Request("https://bridge.example.test/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "test-client",
          client_secret: "test-client-secret",
          ...fields,
        }),
      }));
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
  };
}
