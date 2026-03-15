import { NextResponse } from "next/server";

export function noStoreHeaders(headers?: HeadersInit): Headers {
  const merged = new Headers(headers);
  merged.set("Cache-Control", "no-store");
  return merged;
}

export function noStoreJson(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: noStoreHeaders(init?.headers),
  });
}

export function noStoreRedirect(
  url: string | URL,
  init?: Omit<ResponseInit, "status"> & {
    status?: 301 | 302 | 303 | 307 | 308;
  },
) {
  return NextResponse.redirect(url, {
    ...init,
    headers: noStoreHeaders(init?.headers),
    status: init?.status ?? 303,
  });
}
