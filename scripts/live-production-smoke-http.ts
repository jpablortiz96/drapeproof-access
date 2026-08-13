export type SmokeFetch = typeof fetch;

interface Check {
  name: string;
  path: string;
  status: number[];
  contains?: RegExp;
}

export interface SmokeCheckResult {
  name: string;
  status: number;
  ok: boolean;
}

const CHECKS: Check[] = [
  { name: "homepage", path: "/", status: [200], contains: /DrapeProof/i },
  { name: "try", path: "/try", status: [200], contains: /try/i },
  { name: "health", path: "/api/health", status: [200], contains: /"app":"ok"/ },
  { name: "privacy", path: "/privacy", status: [200], contains: /Perfect Corp|YouCam/i },
  { name: "how-it-works", path: "/how-it-works", status: [200], contains: /visual continuity/i },
  { name: "private-media-rejection", path: "/api/sessions/00000000-0000-4000-8000-000000000000/asset/source", status: [404] },
  { name: "not-found-result", path: "/result?id=00000000-0000-4000-8000-000000000000", status: [200, 404], contains: /not available|expired/i },
];

export async function runNoCostProductionChecks(base: string, fetchImpl: SmokeFetch = fetch): Promise<SmokeCheckResult[]> {
  const results: SmokeCheckResult[] = [];
  for (const check of CHECKS) {
    const response = await fetchImpl(`${base}${check.path}`, { redirect: "manual" });
    const body = await response.text();
    results.push({
      name: check.name,
      status: response.status,
      ok: check.status.includes(response.status) && (!check.contains || check.contains.test(body)),
    });
  }
  return results;
}

export function liveGenerateRequest(base: string, sessionId: string, cookie: string): { url: string; init: RequestInit } {
  if (!/^https:\/\//.test(base)) throw new Error("Live generation requires an HTTPS production origin.");
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("Live generation requires a valid session identifier.");
  if (!/^dp_anon=[A-Za-z0-9_-]+$/.test(cookie)) throw new Error("Live generation requires an in-memory anonymous ownership cookie.");
  return {
    url: `${base}/api/sessions/${encodeURIComponent(sessionId)}?action=generate`,
    init: { method: "POST", headers: { Origin: base, Cookie: cookie } },
  };
}

export async function invokeSingleLiveGenerate(base: string, sessionId: string, cookie: string, fetchImpl: SmokeFetch = fetch): Promise<Response> {
  const request = liveGenerateRequest(base, sessionId, cookie);
  return fetchImpl(request.url, request.init);
}
