export function mutationOriginAllowed(options: { origin: string | null; host: string; fetchSite: string | null; production: boolean }): boolean {
  if (options.fetchSite === "cross-site") return false;
  if (!options.origin) return !options.production;
  try {
    const origin = new URL(options.origin);
    return origin.host === options.host && (!options.production || origin.protocol === "https:");
  } catch { return false; }
}
