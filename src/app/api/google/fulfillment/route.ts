import { NextRequest } from "next/server";
import { executePayload, queryPayload, syncPayload } from "@/lib/google-home";
import { configuredEnvIssues, FULFILLMENT_REQUIRED_ENV, googleAgentUserId } from "@/lib/env";
import { noStoreJson } from "@/lib/response-utils";
import { verifyToken } from "@/lib/tokens";

export const runtime = "nodejs";

type SmartHomeRequest = {
  inputs?: Array<{
    intent?: string;
    payload?: {
      commands?: Array<{
        devices?: Array<{ id?: string }>;
        execution?: Array<{
          command?: string;
          params?: {
            on?: boolean;
          };
        }>;
        executions?: Array<{
          command?: string;
          params?: {
            on?: boolean;
          };
        }>;
      }>;
    };
  }>;
  requestId?: string;
};

function unauthorized() {
  return noStoreJson({ error: "unauthorized" }, { status: 401 });
}

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

export async function POST(request: NextRequest) {
  if (configuredEnvIssues(FULFILLMENT_REQUIRED_ENV).length > 0) {
    return noStoreJson({ error: "service_unavailable" }, { status: 503 });
  }

  const token = bearerToken(request);
  const accessToken = token ? verifyToken(token, "access_token") : null;
  if (!accessToken || accessToken.sub !== googleAgentUserId()) {
    return unauthorized();
  }

  const payload = (await request.json()) as SmartHomeRequest;
  const intent = payload.inputs?.[0]?.intent ?? "";
  const requestId = payload.requestId ?? "";

  if (intent === "action.devices.SYNC") {
    return noStoreJson(syncPayload(requestId));
  }

  if (intent === "action.devices.QUERY") {
    return noStoreJson(await queryPayload(payload));
  }

  if (intent === "action.devices.EXECUTE") {
    return noStoreJson(await executePayload(payload));
  }

  if (intent === "action.devices.DISCONNECT") {
    return noStoreJson({});
  }

  return noStoreJson(
    {
      requestId,
      payload: {
        errorCode: "protocolError",
      },
    },
    { status: 400 },
  );
}
