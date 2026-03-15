import { NextRequest, NextResponse } from "next/server";
import { executePayload, queryPayload, syncPayload } from "@/lib/google-home";
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
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
  const token = bearerToken(request);
  if (!token || !verifyToken(token, "access_token")) {
    console.warn("[fulfillment] unauthorized request");
    return unauthorized();
  }

  const payload = (await request.json()) as SmartHomeRequest;
  const intent = payload.inputs?.[0]?.intent ?? "";
  const requestId = payload.requestId ?? "";

  console.info("[fulfillment] request", { intent, requestId });
  if (intent === "action.devices.EXECUTE" || intent === "action.devices.QUERY") {
    console.info("[fulfillment] payload", { intent, payload, requestId });
  }

  if (intent === "action.devices.SYNC") {
    return NextResponse.json(syncPayload(requestId));
  }

  if (intent === "action.devices.QUERY") {
    return NextResponse.json(await queryPayload(payload));
  }

  if (intent === "action.devices.EXECUTE") {
    return NextResponse.json(await executePayload(payload));
  }

  if (intent === "action.devices.DISCONNECT") {
    return NextResponse.json({});
  }

  return NextResponse.json(
    {
      requestId,
      payload: {
        errorCode: "protocolError",
      },
    },
    { status: 400 },
  );
}
