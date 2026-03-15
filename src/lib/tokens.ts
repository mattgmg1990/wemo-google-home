import { createHmac, timingSafeEqual } from "node:crypto";
import { appSecret } from "@/lib/env";

type TokenKind = "auth_code" | "access_token" | "refresh_token";

export type TokenPayload = {
  exp: number;
  iat: number;
  iss: "wemo-google-home";
  kind: TokenKind;
  redirectUri?: string;
  sub: string;
  username?: string;
};

function encodeBase64Url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function sign(payload: string): string {
  return encodeBase64Url(createHmac("sha256", appSecret()).update(payload).digest());
}

export function issueToken(
  kind: TokenKind,
  sub: string,
  expiresInSeconds: number,
  extra: Partial<Omit<TokenPayload, "exp" | "iat" | "iss" | "kind" | "sub">> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = encodeBase64Url(
    JSON.stringify({
      ...extra,
      exp: now + expiresInSeconds,
      iat: now,
      iss: "wemo-google-home",
      kind,
      sub,
    } satisfies TokenPayload),
  );

  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string, expectedKind: TokenKind): TokenPayload | null {
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) {
    return null;
  }

  const expectedSignature = sign(payloadPart);
  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(signaturePart);

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(payloadPart).toString("utf8")) as TokenPayload;
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== "wemo-google-home" || payload.kind !== expectedKind || payload.exp <= now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
