import { Agent, fetch, type RequestInit } from "undici";

// Keep this dispatcher private to the Pi. Undici waits for the first TLS ALPN
// negotiation: HTTP/2 requests share that connection; HTTP/1.1 can use three
// separate connections so one slow light cannot block the other two.
const dispatcher = new Agent({
  allowH2: true,
  connect: { preferH2: true },
  connections: 3,
  maxConcurrentStreams: 8,
  pingInterval: 0,
  maxResponseSize: 64 * 1024,
});

export function piFetch(url: string, options: RequestInit) {
  // No retry interceptor, background ping, or global fetch/dispatcher change.
  // The caller's AbortSignal covers negotiation, queueing and the response.
  return fetch(url, { ...options, dispatcher });
}
