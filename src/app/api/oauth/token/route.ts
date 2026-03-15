import { NextRequest } from "next/server";
import { configuredEnvIssues, googleClientId, googleClientSecret, OAUTH_REQUIRED_ENV } from "@/lib/env";
import { noStoreJson } from "@/lib/response-utils";
import { issueToken, verifyToken } from "@/lib/tokens";

export const runtime = "nodejs";

type TokenRequest = {
  client_id: string;
  client_secret: string;
  code: string;
  grant_type: string;
  redirect_uri: string;
  refresh_token: string;
};

function jsonError(error: string, status: number) {
  return noStoreJson({ error }, { status });
}

async function parseTokenRequest(request: NextRequest): Promise<TokenRequest> {
  if (request.headers.get("content-type")?.includes("application/json")) {
    const payload = (await request.json()) as Partial<TokenRequest>;
    return {
      client_id: payload.client_id ?? "",
      client_secret: payload.client_secret ?? "",
      code: payload.code ?? "",
      grant_type: payload.grant_type ?? "",
      redirect_uri: payload.redirect_uri ?? "",
      refresh_token: payload.refresh_token ?? "",
    };
  }

  const form = await request.formData();
  return {
    client_id: form.get("client_id")?.toString() ?? "",
    client_secret: form.get("client_secret")?.toString() ?? "",
    code: form.get("code")?.toString() ?? "",
    grant_type: form.get("grant_type")?.toString() ?? "",
    redirect_uri: form.get("redirect_uri")?.toString() ?? "",
    refresh_token: form.get("refresh_token")?.toString() ?? "",
  };
}

export async function POST(request: NextRequest) {
  if (configuredEnvIssues(OAUTH_REQUIRED_ENV).length > 0) {
    return noStoreJson({ error: "service_unavailable" }, { status: 503 });
  }

  const payload = await parseTokenRequest(request);

  if (googleClientId() && payload.client_id !== googleClientId()) {
    return jsonError("invalid_client", 401);
  }

  if (googleClientSecret() && payload.client_secret !== googleClientSecret()) {
    return jsonError("invalid_client", 401);
  }

  if (payload.grant_type === "authorization_code") {
    const code = verifyToken(payload.code, "auth_code");
    if (!code || (code.redirectUri && payload.redirect_uri !== code.redirectUri)) {
      return jsonError("invalid_grant", 400);
    }

    return noStoreJson({
      access_token: issueToken("access_token", code.sub, 3600),
      expires_in: 3600,
      refresh_token: issueToken("refresh_token", code.sub, 60 * 60 * 24 * 180),
      token_type: "Bearer",
    });
  }

  if (payload.grant_type === "refresh_token") {
    const refreshToken = verifyToken(payload.refresh_token, "refresh_token");
    if (!refreshToken) {
      return jsonError("invalid_grant", 400);
    }

    return noStoreJson({
      access_token: issueToken("access_token", refreshToken.sub, 3600),
      expires_in: 3600,
      token_type: "Bearer",
    });
  }

  return jsonError("unsupported_grant_type", 400);
}
