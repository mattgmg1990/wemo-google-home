import { createHmac, timingSafeEqual } from "node:crypto";
import { appSecret } from "@/lib/env";

type TokenKind = "auth_code" | "access_token" | "refresh_token";

type TokenDetails = {
  iat: number;
  iss: "wemo-google-home";
  redirectUri?: string;
  sub: string;
  username?: string;
};

export type TokenPayload = TokenDetails & (
  | { kind: "refresh_token"; exp: number | null }
  | { kind: "auth_code" | "access_token"; exp: number }
);

type TokenExtra = Partial<Pick<TokenDetails, "redirectUri" | "username">>;

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
  extra?: TokenExtra,
): string;
export function issueToken(
  kind: "refresh_token",
  sub: string,
  expiresInSeconds: null,
  extra?: TokenExtra,
): string;
export function issueToken(
  kind: TokenKind,
  sub: string,
  expiresInSeconds: number | null,
  extra: TokenExtra = {},
): string {
  if (
    expiresInSeconds === null
      ? kind !== "refresh_token"
      : !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0
  ) {
    throw new Error("Only refresh tokens may have no expiration; other lifetimes must be positive and finite.");
  }

  const now = Math.floor(Date.now() / 1000);
  const details: TokenDetails = { ...extra, iat: now, iss: "wemo-google-home", sub };
  const tokenPayload: TokenPayload = expiresInSeconds === null
    ? { ...details, kind: "refresh_token", exp: null }
    : { ...details, kind, exp: now + expiresInSeconds };
  const payload = encodeBase64Url(JSON.stringify(tokenPayload));

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
    if (payload.iss !== "wemo-google-home" || payload.kind !== expectedKind) {
      return null;
    }

    // Only newly issued refresh tokens explicitly opt out of expiration.
    // Legacy refresh tokens keep their original expiry and cannot be revived.
    if (
      payload.exp === null
        ? payload.kind !== "refresh_token"
        : typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= now
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
