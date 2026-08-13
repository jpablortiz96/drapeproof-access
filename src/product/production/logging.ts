const SENSITIVE_KEY = /(?:api.?key|authorization|cookie|token|secret|password|signed.?url|blob.?url|database.?url|bytes|image)/i;
const URL_WITH_QUERY = /https?:\/\/[^\s"']+\?[^\s"']+/g;

function redact(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(URL_WITH_QUERY, "[REDACTED_URL]");
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

export function redactLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redact(fields) as Record<string, unknown>;
}

export function logServerEvent(event: string, fields: Record<string, unknown> = {}): void {
  const payload = { timestamp: new Date().toISOString(), event, ...redactLogFields(fields) };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
