# WeMo Google Home Bridge

This repository contains the Next.js app, Pi runtime (`pi/`), and installation,
supervision, rollback and monitoring tools (`ops/`). The app connects three existing Google Home lights to a Raspberry Pi WeMo
bridge. Google device IDs stay stable; the Pi resolves each permanent plug serial
number to its current LAN address.

| Google device ID | WeMo serial |
| --- | --- |
| `wemo-light-behind-the-couch` | `221734K0103D82` |
| `wemo-small-red-light` | `221741K01064DC` |
| `wemo-light-behind-the-chair` | `221633K0101A1F` |

## Request path

- `GET /oauth/authorize`: existing account-linking login.
- `POST /api/oauth/token`: existing OAuth code and refresh exchanges.
- `POST /api/google/fulfillment`: authenticated Google SYNC, QUERY and EXECUTE.
- `GET /api/health`: public aggregate health only, HTTP 200 `{status:"healthy"}`
  or HTTP 503 `{status:"degraded"}`. No device, account, address or secret details.

EXECUTE sends the serial directly to the Pi. It does not first request status or
wait for SSDP discovery. Each light has its own result; one offline plug does not
mark successful commands to other plugs as failures. Multiple operations for one
plug run in order; different plugs run concurrently. All operations share a
7-second deadline. The Pi owns its bounded local retry. Success requires a fresh
reply for the requested serial and the requested on/off state.

QUERY reads the Pi worker's stored observations with one request and a 5-second
transport deadline. This allows measured cold Funnel connections of 2-3 seconds
while leaving time within Google's [9-second fulfillment timeout](https://developers.home.google.com/cloud-to-cloud/analytics/troubleshooting).
Successful requests return immediately; the deadline adds no delay to the fast
path. There is no cloud retry. Concurrent queries share the request, and server
diagnostics log only a fixed failure category and elapsed time on failure.
Cloud inventory caching lasts at most 3 seconds and never falls back to an
expired snapshot when the Pi fails.
Online state requires a successful observation no older than 30 seconds, matching
state/state_value, and the Pi's online flag. Offline or uncertain devices return
`online:false` without an invented on/off value. Duplicate identities fail closed.

Health checks call the authenticated Pi health action with a 5-second timeout.
Cold HTTPS connections through Tailscale Funnel can take more than two seconds
even while all lights are reachable. Health has its own request and budget,
makes only one request and fails closed on timeout or unhealthy
worker/device status. Server diagnostics record a fixed failure category, elapsed
time and health booleans; the public response remains aggregate status only.
Concurrent checks share a request; both success and failure cache for 30 seconds.
The endpoint reports healthy only when the Pi reports a healthy worker, registry,
and devices. It does not trigger network scans or device commands. The Pi worker
and its local watchdog handle recovery; an external monitor can poll this endpoint.

Vercel functions run in `sfo1` to shorten the route to this Pi. The previous
deployment used `iad1`; the Pi's measured relay latency was lower to the West
Coast. This reduces network distance but cannot eliminate internet or Funnel
connection delays.

## Pi API contract

The configured `PI_WEBHOOK_URL` accepts form-encoded HTTPS POSTs with the secret
`X-Wemo-Token` header. Redirects are rejected to avoid forwarding credentials.

- `action=status` returns `{ok:true,devices:[...]}`.
- `action=on|off&device_id=<serial>` returns `{ok:true,device:{...}}` after confirmation.
- `action=health` returns `{ok:true,health:{healthy,workerHealthy,registryHealthy,...}}`.

Each device has `{id,serial,ip,name,state,state_value,online,observedAt,error?}`.
`id` and `serial` are the same permanent serial. `observedAt` is the time of the
last actual successful device observation, in Unix milliseconds, or null if never
observed. State may be retained while offline, and may be null before the first
observation; retained state alone never establishes online status. A 5-second
clock-skew tolerance allows small differences between the Pi and cloud clocks.

## Configuration and development

Use `.env.example` as a template. Keep production credentials in Vercel environment
variables and the Pi's existing protected configuration. Do not commit them.

Required settings are `APP_URL`, `APP_SECRET`, `APP_LOGIN_USERNAME`,
`APP_LOGIN_PASSWORD`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`GOOGLE_REDIRECT_URI`, `GOOGLE_AGENT_USER_ID`, `PI_WEBHOOK_URL`, and
`PI_WEBHOOK_TOKEN`. The legacy `GOOGLE_DEVICE_ID` and `GOOGLE_DEVICE_NAME` settings
are not used by the three-device catalog.

```sh
npm ci
npm test
npx tsc --noEmit
npm run lint
npm run build
npm run dev
```

Tests use fake devices and test-only credentials. They cover permanent identities,
address changes, missing/stale observations, mixed command groups, partial failures,
shared deadlines, private health details, and existing OAuth behavior.

## Deployment and rollback

The Pi runs a background worker that discovers addresses about once a minute and
polls each light about every ten seconds. It keeps permanent identities and last
observations in `/var/lib/wemo/registry.json`; a missed discovery never deletes a
light. Commands verify the serial at the stored address and confirm the actual
state, with a 3.5-second Pi budget. Status and health only read the registry.
Worker and command updates use per-device locks and observation ordering so old
poll results cannot overwrite newer command confirmations.

The worker has startup registration, crash recovery and a heartbeat watchdog.
Only the worker is automatically restarted. See [Pi operations](ops/README.md)
for the hash-checked migration installer, scoped service commands, tests and
rollback. The existing Apache, Funnel and credentials remain in place.

Deploy the compatible Pi bridge first, preserving its token and the existing legacy
API until rollback is no longer needed. Validate its authenticated status, health,
and serial control contract before deploying this cloud version. Preserve the
existing app secrets, Google device IDs and OAuth settings so relinking is not needed.

Build and test, then stage this exact source as a Vercel production deployment
without promoting its public domain. Verify the cloud contract against the Pi,
then promote and check health, SYNC, QUERY and same-state commands. Record the prior
Vercel deployment ID and Pi backup paths before rollout. If rollback is necessary,
restore the previous Vercel deployment first while the Pi's legacy API remains
available, then restore the Pi service/configuration backups.

The October 2026 reconciliation uses the actual production OAuth token format and
form webhook implementation as its baseline, while retaining GitHub's OAuth
configuration checks, token subject checks, login throttling and no-store responses.
The public landing page exposes no configuration checklist or household details.
Earlier GitHub main described a different generic
JSON device API that was not deployed. The two protocols are not interchangeable;
this source uses `PI_WEBHOOK_URL` and `PI_WEBHOOK_TOKEN`. Vercel currently deploys
through its CLI; GitHub push alone is not a deployment. This personal single-user
bridge is not a multi-user product.

CI validates the cloud, monitor, Pi fixtures and operations guards without production
credentials. The Pi's PHP 5.4 / 32-bit runtime and Python 2.7 must also pass their
isolated tests before installation; modern CI does not establish old-runtime
compatibility by itself. Keep the Pi clock synchronized because freshness uses
observation timestamps.

For outside-network checks, run `node ops/check-health.mjs --state /absolute/path/to/wemo.monitor-state.json`
every five minutes from a scheduler. It reads only the public health endpoint,
records consecutive failures locally, emits a failure after three failed checks,
and emits recovery once. A desktop scheduler depends on that computer and app
remaining on; worker recovery runs independently on the Pi. Keep the state path
stable and out of Git. The monitor does not control lights or change deployments.
