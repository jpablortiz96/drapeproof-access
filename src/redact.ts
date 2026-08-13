const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /authorization|api[-_]?key|access[-_]?token|secret/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_QUERY = /(?:signature|credential|token|key|x-amz-)/i;

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if ([...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))) {
      return `${url.origin}${url.pathname}?[REDACTED_QUERY]`;
    }
  } catch {
    // This string is not a URL.
  }
  return value;
}

function redactString(value: string, secrets: readonly string[]): string {
  let redacted = redactUrl(value).replace(BEARER, `Bearer ${REDACTED}`);
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

export function redactSecrets<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === "string") return redactString(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secrets)) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSecrets(item, secrets);
    }
    return output as T;
  }
  return value;
}
