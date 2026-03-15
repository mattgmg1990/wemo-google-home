import styles from "./page.module.css";
import { configuredEnvIssues, googleClientId, googleRedirectUri, OAUTH_REQUIRED_ENV } from "@/lib/env";

type SearchValue = string | string[] | undefined;

type AuthorizePageProps = {
  searchParams: Promise<Record<string, SearchValue>>;
};

function readParam(value: SearchValue): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function mismatchesConfiguredValue(actual: string, expected: string | undefined): boolean {
  return Boolean(expected) && actual !== expected;
}

export default async function AuthorizePage({ searchParams }: AuthorizePageProps) {
  const params = await searchParams;
  const clientId = readParam(params.client_id);
  const redirectUri = readParam(params.redirect_uri);
  const responseType = readParam(params.response_type);
  const state = readParam(params.state);
  const scope = readParam(params.scope);
  const error = readParam(params.error);
  const configurationReady = configuredEnvIssues(OAUTH_REQUIRED_ENV).length === 0;

  const validationError =
    !configurationReady
      ? "Bridge configuration is incomplete. Finish the required environment variables before linking Google Home."
      : responseType !== "code"
      ? "Google must request an authorization code."
      : mismatchesConfiguredValue(clientId, googleClientId())
        ? "This client_id does not match GOOGLE_OAUTH_CLIENT_ID."
        : mismatchesConfiguredValue(redirectUri, googleRedirectUri())
          ? "This redirect_uri does not match GOOGLE_REDIRECT_URI."
          : "";

  const errorMessage =
    validationError ||
    (error === "invalid_login"
      ? "Sign-in failed. Check your username and password."
      : error === "rate_limited"
        ? "Too many sign-in attempts. Wait a few minutes and try again."
        : error === "bridge_not_configured"
          ? "Bridge configuration is incomplete. Finish the required environment variables before linking Google Home."
          : "");

  return (
    <main className={styles.page}>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>Link Google Home</p>
        <h1 className={styles.title}>Authorize your self-hosted bridge.</h1>
        <p className={styles.lede}>
          Sign in with your bridge credentials to link this development integration
          and let Google Home control the devices you configured.
        </p>
        <p className={styles.notice}>
          By signing in, you are authorizing Google to control your configured devices.
        </p>

        {errorMessage ? <p className={styles.error}>{errorMessage}</p> : null}

        <form className={styles.form} action="/oauth/authorize/complete" method="post">
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="response_type" value={responseType} />
          <input type="hidden" name="scope" value={scope} />
          <input type="hidden" name="state" value={state} />

          <label className={styles.field}>
            <span>Username</span>
            <input autoComplete="username" disabled={Boolean(validationError)} name="username" type="text" />
          </label>

          <label className={styles.field}>
            <span>Password</span>
            <input
              autoComplete="current-password"
              disabled={Boolean(validationError)}
              name="password"
              type="password"
            />
          </label>

          <button className={styles.button} disabled={Boolean(validationError)} type="submit">
            Link Google Home
          </button>
        </form>
      </section>
    </main>
  );
}
