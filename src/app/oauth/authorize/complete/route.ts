import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  appLoginPassword,
  appLoginUsername,
  googleAgentUserId,
  googleClientId,
  googleRedirectUri,
} from "@/lib/env";
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

  if (responseType !== "code") {
    return NextResponse.json({ error: "unsupported_response_type" }, { status: 400 });
  }

  if (googleClientId() && clientId !== googleClientId()) {
    return NextResponse.json({ error: "invalid_client" }, { status: 400 });
  }

  if (googleRedirectUri() && redirectUri !== googleRedirectUri()) {
    return NextResponse.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }

  if (!stableCompare(username, appLoginUsername()) || !stableCompare(password, appLoginPassword())) {
    return NextResponse.redirect(authorizePageUrl(request, form, "invalid_login"), {
      status: 303,
    });
  }

  const code = issueToken("auth_code", googleAgentUserId(), 300, {
    redirectUri,
    username,
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) {
    redirect.searchParams.set("state", state);
  }

  return NextResponse.redirect(redirect, { status: 303 });
}
