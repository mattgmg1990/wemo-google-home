import styles from "./page.module.css";
import { safeConfiguredDevices } from "@/lib/bridge-devices";
import { appUrl, coreBridgeReady, envChecklist } from "@/lib/env";

const steps = [
  "Deploy this app to Vercel and configure the environment variables.",
  "Stand up a tiny local device API that can list devices and switch them on or off.",
  "Expose that local API over HTTPS with Tailscale Funnel.",
  "Create a Google Home developer project with cloud-to-cloud account linking.",
  "Link the [test] integration from the Google Home app and control your devices.",
];

export default function Home() {
  const baseUrl = appUrl();
  const checklist = envChecklist();
  const bridgeReady = coreBridgeReady();
  const devices = safeConfiguredDevices();

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>Self-Hosted Smart Home Bridge</p>
        <h1 className={styles.title}>Keep legacy WeMo devices alive with Google Home.</h1>
        <p className={styles.lede}>
          This app exposes an arbitrary list of on/off devices to Google Home, then forwards
          commands to a local API running on hardware you control inside your home network.
        </p>
        <div className={bridgeReady ? styles.bannerReady : styles.bannerPending}>
          <strong>{bridgeReady ? "Bridge ready" : "Setup in progress"}</strong>
          <span>
            {bridgeReady
              ? "Core bridge settings are configured. Finish the Google-issued OAuth values after you create the Google Home developer project."
              : "Configure the bridge secrets, local device API, and device list first, then finish the Google-issued OAuth values from Google Home Developer Console."}
          </span>
        </div>
      </section>

      <section className={styles.cardGrid}>
        <article className={styles.card}>
          <h2 className={styles.cardTitle}>Google Endpoints</h2>
          <dl className={styles.definitionList}>
            <div>
              <dt>Authorize URL</dt>
              <dd>{baseUrl}/oauth/authorize</dd>
            </div>
            <div>
              <dt>Token URL</dt>
              <dd>{baseUrl}/api/oauth/token</dd>
            </div>
            <div>
              <dt>Fulfillment URL</dt>
              <dd>{baseUrl}/api/google/fulfillment</dd>
            </div>
            <div>
              <dt>Configured Devices</dt>
              <dd>
                {devices.ok
                  ? `${devices.devices.length} device${devices.devices.length === 1 ? "" : "s"}`
                  : "Waiting for DEVICE_CONFIG_JSON"}
              </dd>
            </div>
          </dl>
          {devices.ok ? (
            <ul className={styles.deviceList}>
              {devices.devices.map((device) => (
                <li key={device.id}>
                  <strong>{device.name}</strong>
                  <span>
                    {device.type.replace("action.devices.types.", "")}
                    {device.roomHint ? ` in ${device.roomHint}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.cardNote}>{devices.error}</p>
          )}
        </article>

        <article className={styles.card}>
          <h2 className={styles.cardTitle}>Environment</h2>
          <ul className={styles.checklist}>
            {checklist.map((item) => (
              <li
                key={item.name}
                className={
                  item.status === "configured"
                    ? styles.ready
                    : item.status === "pending_google"
                      ? styles.pending
                      : item.status === "invalid"
                        ? styles.invalid
                        : styles.missing
                }
              >
                <span>{item.name}</span>
                <strong>
                  {item.status === "configured"
                    ? "Configured"
                    : item.status === "pending_google"
                      ? "Pending Google"
                      : item.status === "invalid"
                        ? "Invalid"
                        : "Missing"}
                </strong>
              </li>
            ))}
          </ul>
          {checklist.some((item) => item.status === "invalid") ? (
            <div className={styles.cardNote}>
              {checklist
                .filter((item) => item.status === "invalid")
                .map((item) => (
                  <p key={item.name}>
                    <strong>{item.name}:</strong> {item.error}
                  </p>
                ))}
            </div>
          ) : null}
        </article>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Build Order</h2>
        <ol className={styles.steps}>
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}
