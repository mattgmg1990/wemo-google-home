# WeMo Google Home Bridge

Belkin's official announcement, [Wemo Support Ending - What You Need to Know](https://www.belkin.com/support-article/?articleNum=335419), says select WeMo products lose Wemo cloud services and app support effective **January 31, 2026**. Belkin also says that after that date the Wemo app, remote access, and voice assistant integrations such as Google Assistant stop working for affected devices.

This repo exists for one simple reason: keep using a house full of perfectly good old WeMo devices after the official cloud shuts down. With an unpublished Google Home app and a small server running inside your house, you can still control your lights with Google after the official cloud disappears.

I used a Raspberry Pi for the local server, but any always-on machine that can run a small web service works: a desktop, mini PC, NAS, home server, or anything similar.

This project is for a **personal, unpublished Google Home developer integration**. It currently supports **arbitrary numbers of on/off devices** using the Google `OnOff` trait.

## How It Works

```text
Google Home app / Google Assistant
            |
            v
    Google Smart Home platform
            |
            v
   Vercel-hosted Next.js bridge
            |
            v
    Tailscale Funnel HTTPS URL
            |
            v
   Local device API in your home
            |
            v
        WeMo devices
```

## Prerequisites

- A Google account.
- A Vercel account. Vercel's pricing page currently lists a [Hobby plan](https://vercel.com/pricing) that works well for small personal projects.
- A Tailscale account. Tailscale's pricing page currently says it is [free for personal use](https://tailscale.com/pricing).
- An always-on machine inside your home network.
- A way for that machine to discover and control your WeMo devices locally.
- A GitHub repo containing this project so Vercel can import it.

## Step 1: Build a Local Device Server

This is the part we still need to build out in this repo later.

For now, this bridge expects a separate local HTTP server that does all device-specific work:

- discovers the WeMo devices you care about
- knows how to switch each device on or off locally
- returns current state for all configured devices
- verifies a bearer token before accepting requests

Your local server can be written in anything. Node, Python, Go, Rust, or a shell script behind a tiny web server are all fair game.

### Expected local API contract

This Vercel bridge sends `POST` requests with:

- `Content-Type: application/json`
- `Authorization: Bearer <DEVICE_API_TOKEN>`

Request body:

```json
{
  "action": "status"
}
```

or:

```json
{
  "action": "on",
  "deviceId": "desk-lamp"
}
```

or:

```json
{
  "action": "off",
  "deviceId": "desk-lamp"
}
```

Success response for `status`:

```json
{
  "ok": true,
  "devices": [
    {
      "id": "desk-lamp",
      "name": "Desk Lamp",
      "online": true,
      "state": "off"
    },
    {
      "id": "coffee-bar",
      "name": "Coffee Bar",
      "online": true,
      "state": "on"
    }
  ]
}
```

Success response for `on` or `off`:

```json
{
  "ok": true,
  "device": {
    "id": "desk-lamp",
    "name": "Desk Lamp",
    "online": true,
    "state": "on"
  }
}
```

Error response:

```json
{
  "ok": false,
  "error": "Device not found"
}
```

### Important mapping rule

`deviceId` in the local API should match the `localId` field in `DEVICE_CONFIG_JSON`.

That means you can:

- use a stable slug like `desk-lamp`
- use a MAC address or other internal identifier
- use a device name if your local server already treats names as the stable identifier

I recommend a stable slug instead of a display name so you can rename devices in Google Home later without breaking the local API.

## Step 2: Expose the Local API with Tailscale

Official docs:

- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [Tailscale pricing](https://tailscale.com/pricing)

The goal is to expose **one** HTTPS endpoint from your home network for the local device API.

### Suggested flow

1. Install Tailscale on the always-on machine and sign in.
2. Confirm the local device API is running on a local port such as `127.0.0.1:8787`.
3. Use Tailscale Serve to proxy that local port.
4. Use Tailscale Funnel to make that Serve endpoint publicly reachable over HTTPS.
5. Copy the resulting public HTTPS URL into `DEVICE_API_URL` in Vercel. This can be the root URL or a full path such as `https://example.ts.net/device-api`.
6. Protect the endpoint with `DEVICE_API_TOKEN`, since Funnel makes it internet reachable.

### Practical notes

- Keep the local API small and purpose-built. One endpoint is enough.
- Funnel DNS and certificate provisioning can take a few minutes the first time.
- You may need the correct Tailscale user role or tailnet policy permission to enable Funnel, as described in the Funnel docs.
- If you change the public Funnel URL later, update `DEVICE_API_URL` in Vercel.

## Step 3: Deploy This App to Vercel

Official docs:

- [Import a GitHub repository into Vercel](https://vercel.com/docs/git/vercel-for-github)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Vercel pricing](https://vercel.com/pricing)

### Deploy steps

1. Push this repo to GitHub.
2. In Vercel, create a new project from that GitHub repo.
3. Keep the default framework detection for Next.js.
4. Before the first production deployment finishes, add the environment variables from the next section.
5. Deploy the project.
6. After deploy, note your Vercel production URL. That becomes `APP_URL`.

### Recommended Vercel workflow

1. Create the project.
2. Add all non-Google environment variables first.
3. Deploy once.
4. Use the deployed URLs while configuring Google Home.
5. Add the Google-issued OAuth values.
6. Redeploy.

### Environment Variables

Copy [`.env.example`](./.env.example) to `.env.local` for local development, and add the same values in Vercel for production.

| Variable | Required | Purpose |
| --- | --- | --- |
| `APP_URL` | Yes | Public base URL for this Next.js app, such as `https://your-app.vercel.app` |
| `APP_SECRET` | Yes | HMAC signing secret for auth codes, access tokens, and refresh tokens |
| `APP_LOGIN_USERNAME` | Yes | Username for the account-linking sign-in page |
| `APP_LOGIN_PASSWORD` | Yes | Password for the account-linking sign-in page |
| `GOOGLE_OAUTH_CLIENT_ID` | Later | Client ID Google gives you in the developer console |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Later | Client secret Google gives you in the developer console |
| `GOOGLE_REDIRECT_URI` | Later | Redirect URI Google gives you for account linking |
| `GOOGLE_AGENT_USER_ID` | Yes | Stable user ID returned to Google for this one-user personal bridge |
| `DEVICE_API_URL` | Yes | Public HTTPS URL of your Tailscale Funnel local device API |
| `DEVICE_API_TOKEN` | Yes | Bearer token this app uses when calling the local device API |
| `DEVICE_CONFIG_JSON` | Yes | JSON array describing the devices to expose to Google Home |

### Generating `APP_SECRET`

Use any long random string from a password manager or secrets tool. Keep it private and do not commit it.

### `DEVICE_CONFIG_JSON` format

Example:

```json
[
  {
    "id": "desk-lamp",
    "localId": "desk-lamp",
    "name": "Desk Lamp",
    "nicknames": ["Desk"],
    "type": "action.devices.types.LIGHT",
    "roomHint": "Office"
  },
  {
    "id": "coffee-bar",
    "localId": "coffee-bar",
    "name": "Coffee Bar",
    "type": "action.devices.types.OUTLET",
    "roomHint": "Kitchen"
  }
]
```

In Vercel, it is easiest to paste `DEVICE_CONFIG_JSON` as a single-line JSON string.

Fields:

- `id`: required stable Google device ID
- `localId`: optional stable identifier passed to your local API; defaults to `id`
- `name`: required display name shown in Google Home
- `nicknames`: optional additional names users might speak
- `type`: optional Google device type such as `action.devices.types.LIGHT`; defaults to `action.devices.types.OUTLET`
- `roomHint`: optional room hint shown to Google Home

### Current trait support

Every configured device is exposed with:

- `action.devices.traits.OnOff`

So choose Google device types that make sense for simple on/off behavior.

## Step 4: Configure the Google Home Developer Project

Official docs:

- [Create a developer project](https://developers.home.google.com/cloud-to-cloud/project/create)
- [Implement an OAuth 2.0 server](https://developers.home.google.com/cloud-to-cloud/project/authorization)
- [Identify and sync](https://developers.home.google.com/cloud-to-cloud/integration/sync)
- [Query and execute](https://developers.home.google.com/cloud-to-cloud/integration/query-execute)
- [Google Home Test Suite](https://developers.home.google.com/tools/test-suite)

### Create the project

1. Open the Google Home Developer Console.
2. Make sure you are using the same Google account you plan to use in the Google Home app on your phone.
3. Create a new cloud-to-cloud project.
4. Give it a simple name like `Wemo Bridge`.
5. Add the app branding details Google asks for.
6. Choose cloud-to-cloud as the integration type.

### Configure account linking

This repo already implements the OAuth server endpoints Google expects.

Use these values in Google Home Developer Console:

- Authorization URL: `https://YOUR_APP_URL/oauth/authorize`
- Token URL: `https://YOUR_APP_URL/api/oauth/token`

Google will also give you values you must copy back into Vercel:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`

### Configure fulfillment

Set the cloud fulfillment URL to:

- `https://YOUR_APP_URL/api/google/fulfillment`

### Match your device model to this repo

This app currently supports a device list made from `DEVICE_CONFIG_JSON`, and it answers:

- `SYNC`
- `QUERY`
- `EXECUTE`

It does not currently implement advanced traits or Report State.

### Recommended verification steps

1. Make sure the Vercel app is deployed and loads successfully.
2. Make sure the local API is reachable through the Funnel URL.
3. Run through account linking once.
4. Use the [Google Home Test Suite](https://developers.home.google.com/tools/test-suite) to validate the cloud-to-cloud integration before debugging inside the phone app.

## Step 5: Link the Development Integration in the Google Home App

Helpful references:

- [Google Home app support: control smart home devices added to the Google Home app](https://support.google.com/googlenest/answer/7073578)
- [Google Home Test Suite](https://developers.home.google.com/tools/test-suite)

### Phone setup flow

1. Open the Google Home app on your phone.
2. Start the flow to add a new Works with Google Home device or service.
3. Search for the developer integration name you created in Google Home Developer Console.
4. If Google shows a `[test]` prefix for the integration, that is expected for an unpublished developer setup.
5. Select the integration.
6. Sign in using `APP_LOGIN_USERNAME` and `APP_LOGIN_PASSWORD`.
7. Accept the Google account-linking prompt.
8. Wait for Google Home to run device sync.
9. Assign the devices to homes and rooms if prompted.

If the integration does not appear in the Google Home app, the first thing to check is that the phone app and the Google Home Developer Console are using the same Google account.

### First tests

Try commands like:

- `Hey Google, turn on Desk Lamp`
- `Hey Google, turn off Coffee Bar`
- `Hey Google, turn on all lights in the Office`

If a command fails:

1. Check Vercel function logs.
2. Check the local API logs on your always-on machine.
3. Confirm the `localId` values in `DEVICE_CONFIG_JSON` match the device IDs your local API expects.
4. Confirm the Funnel URL still works and the bearer token matches.

## Local Development

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

For local testing, you can point `DEVICE_API_URL` at any reachable HTTPS URL that serves the expected local API contract.

## License

Apache-2.0. See [LICENSE](./LICENSE).
