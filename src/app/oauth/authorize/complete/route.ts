import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  appLoginPassword,
  appLoginUsername,
  configuredEnvIssues,
  googleAgentUserId,
  googleClientId,
  googleRedirectUri,
  OAUTH_REQUIRED_ENV,
} from "@/lib/env";
import { clearLoginRateLimit, loginRateLimitStatus, recordFailedLoginAttempt } from "@/lib/rate-limit";
import { noStoreHeaders, noStoreRedirect } from "@/lib/response-utils";
import { issueToken } from "@/lib/tokens";

export const runtime = "nodejs";

function stableCompare(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function authorizePageUrl(request: NextRequest, form: FormData, error: string): URL {
  const url = new URL("/oauth/authorize", request.url);
  for (const key of ["client_id", "redirect_uri", "response_type", "scope", "state"]) {
    const value = form.get(key)?.toString();
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  url.searchParams.set("error", error);
  return url;
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const clientId = form.get("client_id")?.toString() ?? "";
  const redirectUri = form.get("redirect_uri")?.toString() ?? "";
  const responseType = form.get("response_type")?.toString() ?? "";
  const state = form.get("state")?.toString() ?? "";
  const username = form.get("username")?.toString() ?? "";
  const password = form.get("password")?.toString() ?? "";
  const oauthIssues = configuredEnvIssues(OAUTH_REQUIRED_ENV);

  if (responseType !== "code") {
    return NextResponse.json(
      { error: "unsupported_response_type" },
      { headers: noStoreHeaders(), status: 400 },
    );
  }

  if (oauthIssues.length > 0) {
    return noStoreRedirect(authorizePageUrl(request, form, "bridge_not_configured"));
  }

  if (googleClientId() && clientId !== googleClientId()) {
    return NextResponse.json({ error: "invalid_client" }, { headers: noStoreHeaders(), status: 400 });
  }

  if (googleRedirectUri() && redirectUri !== googleRedirectUri()) {
    return NextResponse.json(
      { error: "invalid_redirect_uri" },
      { headers: noStoreHeaders(), status: 400 },
    );
  }

  const rateLimit = loginRateLimitStatus(request);
  if (rateLimit.limited) {
    return noStoreRedirect(authorizePageUrl(request, form, "rate_limited"), {
      headers: {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      },
    });
  }

  if (!stableCompare(username, appLoginUsername()) || !stableCompare(password, appLoginPassword())) {
    const nextRateLimit = recordFailedLoginAttempt(request);
    return noStoreRedirect(
      authorizePageUrl(request, form, nextRateLimit.limited ? "rate_limited" : "invalid_login"),
      {
        headers: nextRateLimit.limited
          ? {
              "Retry-After": String(nextRateLimit.retryAfterSeconds),
            }
          : undefined,
      },
    );
  }

  clearLoginRateLimit(request);

  const code = issueToken("auth_code", googleAgentUserId(), 300, {
    redirectUri,
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) {
    redirect.searchParams.set("state", state);
  }

  return NextResponse.redirect(redirect, {
    headers: noStoreHeaders(),
    status: 303,
  });
}
