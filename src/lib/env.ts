import { parseDeviceConfigJson } from "@/lib/device-config";

const OPTIONAL_ENV = [
  "APP_URL",
  "APP_SECRET",
  "APP_LOGIN_USERNAME",
  "APP_LOGIN_PASSWORD",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_AGENT_USER_ID",
  "DEVICE_API_URL",
  "DEVICE_API_TOKEN",
  "DEVICE_CONFIG_JSON",
] as const;

type EnvKey = (typeof OPTIONAL_ENV)[number];
type EnvStatus = "configured" | "invalid" | "missing" | "pending_google";

const GOOGLE_MANAGED_ENV = new Set<EnvKey>([
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
]);

function readEnv(name: EnvKey): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function validateEnv(name: EnvKey, value: string): string | undefined {
  if (name !== "DEVICE_CONFIG_JSON") {
    return undefined;
  }

  try {
    parseDeviceConfigJson(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid DEVICE_CONFIG_JSON.";
  }
}

export function appUrl(): string {
  return (readEnv("APP_URL") ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function googleClientId(): string | undefined {
  return readEnv("GOOGLE_OAUTH_CLIENT_ID");
}

export function googleClientSecret(): string | undefined {
  return readEnv("GOOGLE_OAUTH_CLIENT_SECRET");
}

export function googleRedirectUri(): string | undefined {
  return readEnv("GOOGLE_REDIRECT_URI");
}

export function googleAgentUserId(): string {
  return readEnv("GOOGLE_AGENT_USER_ID") ?? "self-hosted-bridge-user";
}

export function appLoginUsername(): string {
  return readEnv("APP_LOGIN_USERNAME") ?? "bridge-admin";
}

export function appLoginPassword(): string {
  return requiredEnv("APP_LOGIN_PASSWORD");
}

export function appSecret(): string {
  return requiredEnv("APP_SECRET");
}

export function deviceApiUrl(): string {
  return requiredEnv("DEVICE_API_URL");
}

export function deviceApiToken(): string {
  return requiredEnv("DEVICE_API_TOKEN");
}

export function deviceConfigJson(): string {
  return requiredEnv("DEVICE_CONFIG_JSON");
}

export function requiredEnv(name: EnvKey): string {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`${name} is not configured.`);
  }

  const validationError = validateEnv(name, value);
  if (validationError) {
    throw new Error(validationError);
  }

  return value;
}

export function envChecklist(): Array<{
  configured: boolean;
  error?: string;
  name: EnvKey;
  status: EnvStatus;
}> {
  return OPTIONAL_ENV.map((name) => {
    const value = readEnv(name);
    const validationError = value ? validateEnv(name, value) : undefined;

    return {
      configured: Boolean(value) && !validationError,
      error: validationError,
      name,
      status: validationError
        ? "invalid"
        : value
          ? "configured"
          : GOOGLE_MANAGED_ENV.has(name)
            ? "pending_google"
            : "missing",
    };
  });
}

export function coreBridgeReady(): boolean {
  return envChecklist().every((item) =>
    item.status === "configured" || item.status === "pending_google",
  );
}
