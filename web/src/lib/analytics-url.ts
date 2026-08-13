const PRIVATE_DYNAMIC_SEGMENT = /\/(session|result|passport)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi;

export function normalizeAnalyticsUrl(value: string): string {
  const base = typeof location === "undefined" ? "https://drapeproof.invalid" : location.origin;
  const url = new URL(value, base);
  url.pathname = url.pathname.replace(PRIVATE_DYNAMIC_SEGMENT, (_match, area: string) => `/${area}/[id]`);
  url.search = "";
  url.hash = "";
  return /^https?:\/\//i.test(value) ? url.toString() : `${url.pathname}`;
}
