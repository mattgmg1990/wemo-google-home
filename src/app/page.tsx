import styles from "./page.module.css";

const steps = [
  "Deploy this app and configure the required environment variables.",
  "Run a local device API on an always-on machine inside your home network.",
  "Expose that local API over HTTPS, then point this bridge at it.",
  "Create and link your unpublished Google Home developer integration.",
];

export default function Home() {
  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>Self-Hosted Smart Home Bridge</p>
        <h1 className={styles.title}>Google Home endpoint for a personal WeMo bridge.</h1>
        <p className={styles.lede}>
          This deployment hosts the OAuth and fulfillment endpoints for an unpublished Google
          Home integration. Device names, room hints, and configuration details are intentionally
          hidden on this public page.
        </p>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Setup Order</h2>
        <ol className={styles.steps}>
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}
