import { googleAgentUserId } from "@/lib/env";
import { deviceIsFresh, EXECUTE_BUDGET_MS, getPiDevices, PiDevice, setPiDevice } from "@/lib/pi";

type IntentRequest = {
  inputs?: Array<{
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
      devices?: Array<{ id?: string }>;
    };
  }>;
  requestId?: string;
};

type DeviceStatePayload = Record<
  string,
  {
    on?: boolean;
    online: boolean;
  }
>;

type WemoGoogleDevice = {
  defaultNames: string[];
  googleId: string;
  serial: string;
  name: string;
  nicknames: string[];
};

const googleDevices: WemoGoogleDevice[] = [
  {
    defaultNames: ["Light Behind the Couch"],
    googleId: "wemo-light-behind-the-couch",
    serial: "221734K0103D82",
    name: "Light Behind the Couch",
    nicknames: ["Couch Light"],
  },
  {
    defaultNames: ["Small Red Light"],
    googleId: "wemo-small-red-light",
    serial: "221741K01064DC",
    name: "Small Red Light",
    nicknames: ["Red Light"],
  },
  {
    defaultNames: ["Light Behind the Chair"],
    googleId: "wemo-light-behind-the-chair",
    serial: "221633K0101A1F",
    name: "Light Behind the Chair",
    nicknames: ["Chair Light"],
  },
] as const;

const deviceById = new Map(googleDevices.map((device) => [device.googleId, device]));
function executionsForCommand(
  command:
    | {
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
      }
    | undefined,
) {
  return command?.execution ?? command?.executions ?? [];
}

function allKnownDeviceIds() {
  return googleDevices.map((device) => device.googleId);
}

function requestedQueryDeviceIds(request: IntentRequest): string[] {
  return (
    request.inputs?.flatMap((input) =>
      input.payload?.devices?.flatMap((device) => (device.id ? [device.id] : [])) ?? [],
    ) ?? []
  );
}

function fallbackDeviceIds(deviceIds: string[]): string[] {
  return deviceIds.length > 0 ? deviceIds : allKnownDeviceIds();
}

function requestedOnState(request: IntentRequest): boolean | null {
  const inputs = request.inputs ?? [];

  for (const input of inputs) {
    for (const command of input.payload?.commands ?? []) {
      for (const execution of executionsForCommand(command)) {
        const commandName = execution.command?.toLowerCase() ?? "";

        if (commandName.includes("onoff_on")) {
          return true;
        }

        if (commandName.includes("onoff_off")) {
          return false;
        }

        if (typeof execution.command === "string" && commandName.includes("onoff")) {
          if (typeof execution.params?.on === "boolean") {
            return execution.params.on;
          }

          if (execution.params != null) {
            for (const value of Object.values(execution.params)) {
              if (typeof value === "boolean") {
                return value;
              }
            }
          }
        }

        const serializedExecution = JSON.stringify(execution);
        if (serializedExecution.includes("ONOFF_ON")) {
          return true;
        }

        if (serializedExecution.includes("ONOFF_OFF")) {
          return false;
        }
      }
    }
  }

  return null;
}

function deviceStatePayload(deviceIds: string[], devices: PiDevice[]): DeviceStatePayload {
  return Object.fromEntries(deviceIds.map((deviceId) => {
    const known = deviceById.get(deviceId);
    // Duplicate serials and disagreement between the two identity fields fail closed.
    const matches = known ? devices.filter((device) => device.id === known.serial || device.serial === known.serial) : [];
    const match = matches.length === 1 ? matches[0] : undefined;
    const online = match != null && match.id === known?.serial && match.serial === known?.serial && deviceIsFresh(match);
    return [deviceId, online ? { on: match.state === "on", online: true } : { online: false }];
  }));
}

export function syncPayload(requestId: string) {
  return {
    requestId,
    payload: {
      agentUserId: googleAgentUserId(),
      devices: googleDevices.map((device) => ({
        id: device.googleId,
        type: "action.devices.types.LIGHT",
        traits: ["action.devices.traits.OnOff"],
        name: {
          defaultNames: device.defaultNames,
          name: device.name,
          nicknames: device.nicknames,
        },
        willReportState: false,
        attributes: {},
        deviceInfo: {
          manufacturer: "Belkin / Raspberry Pi bridge",
          model: "Legacy WeMo bridge",
        },
      })),
    },
  };
}

export async function queryPayload(request: IntentRequest) {
  const requestId = request.requestId ?? "";
  const ids = fallbackDeviceIds(requestedQueryDeviceIds(request));
  try {
    const devices = await getPiDevices();
    return { requestId, payload: { devices: deviceStatePayload(ids, devices) } };
  } catch {
    // A previous observation cannot establish reachability after the Pi fails.
    return { requestId, payload: { devices: deviceStatePayload(ids, []) } };
  }
}

export async function executePayload(request: IntentRequest) {
  const deadline = Date.now() + EXECUTE_BUDGET_MS;
  const requestId = request.requestId ?? "";
  const commands = request.inputs?.flatMap((input) => input.payload?.commands ?? []) ?? [];
  // Keep each command's intent attached to its targets. Commands for the same
  // light run in order; independent lights can complete concurrently.
  const operationsByDevice = new Map<string, Array<boolean | null>>();
  for (const command of commands) {
    // EXECUTE must name its targets; a malformed command must never expand a
    // neighboring command to every light in the catalog.
    const ids = command.devices?.flatMap((device) => device.id ? [device.id] : []) ?? [];
    const executions = executionsForCommand(command);
    const desiredStates = executions.length === 0 ? [null] : executions.map((execution) =>
      requestedOnState({ inputs: [{ payload: { commands: [{ execution: [execution] }] } }] }),
    );
    for (const deviceId of new Set(ids)) {
      const operations = operationsByDevice.get(deviceId) ?? [];
      operations.push(...desiredStates);
      operationsByDevice.set(deviceId, operations);
    }
  }
  if (operationsByDevice.size === 0) {
    return { requestId, payload: { errorCode: "protocolError" } };
  }

  console.info("[fulfillment] execute request", {
    requestId,
    commands: commands.map((command) => ({
      deviceIds: command.devices?.map((device) => device.id ?? "<missing-id>") ?? [],
      executions: executionsForCommand(command).map((execution) => ({
        command: execution.command ?? "<missing-command>",
        on: execution.params?.on,
      })),
    })),
    responseDeviceIds: [...operationsByDevice.keys()],
  });

  // Every task catches its own failure, so Promise.all waits for all lights and
  // an absent light cannot turn a confirmed success into a group-wide failure.
  const results = await Promise.all([...operationsByDevice].map(async ([deviceId, operations]) => {
    const device = deviceById.get(deviceId);
    if (!device) {
      return { ids: [deviceId], status: "ERROR", errorCode: "deviceNotFound" };
    }
    if (operations.some((on) => on === null)) {
      return { ids: [deviceId], status: "ERROR", errorCode: "functionNotSupported" };
    }

    try {
      let updatedDevice: PiDevice | undefined;
      for (const desiredState of operations) {
        updatedDevice = await setPiDevice(device.serial, desiredState ? "on" : "off", deadline);
      }
      const confirmedOn = updatedDevice?.state === "on";
      console.info("[fulfillment] execute result", { requestId, deviceId, on: confirmedOn });
      return {
        ids: [deviceId],
        status: "SUCCESS",
        states: { on: confirmedOn, online: true },
      };
    } catch (error) {
      console.error("[fulfillment] execute failed", {
        requestId,
        deviceId,
        error: error instanceof Error ? error.message : "unknown error",
      });
      return { ids: [deviceId], status: "ERROR", errorCode: "deviceOffline" };
    }
  }));

  return { requestId, payload: { commands: results } };
}
