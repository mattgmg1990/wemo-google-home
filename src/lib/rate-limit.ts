import type { NextRequest } from "next/server";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

type LoginFailureBucket = {
  count: number;
  resetAt: number;
};

const loginFailures = new Map<string, LoginFailureBucket>();

function cleanupExpiredBuckets(now: number) {
  for (const [key, bucket] of loginFailures) {
    if (bucket.resetAt <= now) {
      loginFailures.delete(key);
    }
  }
}

function requestFingerprint(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ip = forwardedFor?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  const userAgent = request.headers.get("user-agent") || "unknown";
  return `${ip}|${userAgent}`;
}

function currentBucket(request: NextRequest, now: number): LoginFailureBucket | undefined {
  cleanupExpiredBuckets(now);
  return loginFailures.get(requestFingerprint(request));
}

export function loginRateLimitStatus(request: NextRequest): {
  limited: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const bucket = currentBucket(request, now);
  if (!bucket || bucket.count < MAX_LOGIN_FAILURES) {
    return {
      limited: false,
      retryAfterSeconds: 0,
    };
  }

  return {
    limited: true,
    retryAfterSeconds: Math.max(Math.ceil((bucket.resetAt - now) / 1000), 1),
  };
}

export function recordFailedLoginAttempt(request: NextRequest): {
  limited: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const key = requestFingerprint(request);
  const existing = currentBucket(request, now);

  const nextBucket = existing
    ? {
        count: existing.count + 1,
        resetAt: existing.resetAt,
      }
    : {
        count: 1,
        resetAt: now + LOGIN_WINDOW_MS,
      };

  loginFailures.set(key, nextBucket);

  return {
    limited: nextBucket.count >= MAX_LOGIN_FAILURES,
    retryAfterSeconds: Math.max(Math.ceil((nextBucket.resetAt - now) / 1000), 1),
  };
}

export function clearLoginRateLimit(request: NextRequest) {
  loginFailures.delete(requestFingerprint(request));
}
