import { homedir } from "node:os";
import { join } from "node:path";
import { isObject } from "./guards";

export function resolveOpenClawHome(override?: string): string {
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }

  const envOverride = process.env.OPENCLAW_HOME?.trim();
  if (envOverride) {
    return envOverride;
  }

  return join(homedir(), ".openclaw");
}

export function readGatewayPort(config: unknown): number | null {
  if (!isObject(config)) {
    return null;
  }

  const gateway = config.gateway;
  if (!isObject(gateway)) {
    return null;
  }

  return typeof gateway.port === "number" && Number.isFinite(gateway.port) ? gateway.port : null;
}

export function readGatewayToken(config: unknown): string | undefined {
  if (!isObject(config)) {
    return undefined;
  }

  const gateway = config.gateway;
  if (!isObject(gateway)) {
    return undefined;
  }

  const auth = gateway.auth;
  if (!isObject(auth)) {
    return undefined;
  }

  return typeof auth.token === "string" && auth.token.trim().length > 0 ? auth.token : undefined;
}

export function resolveApiBaseUrlFromConfig(config: unknown, portOverride?: number): string {
  const port = portOverride ?? readGatewayPort(config) ?? 18789;
  return `http://127.0.0.1:${port}`;
}
