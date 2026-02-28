export const DEFAULT_GATEWAY_BASE_URL = "http://127.0.0.1:18789";

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function resolveGatewayBaseUrl(explicitBaseUrl?: string): string {
  const configuredBaseUrl = explicitBaseUrl ?? process.env.OPENCLAW_GATEWAY_URL ?? DEFAULT_GATEWAY_BASE_URL;
  return normalizeBaseUrl(configuredBaseUrl);
}
