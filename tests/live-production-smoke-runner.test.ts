import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { invokeSingleLiveGenerate, liveGenerateRequest, runNoCostProductionChecks } from "../scripts/live-production-smoke-http.js";

const base = "https://drapeproof-access.example";
const sessionId = "00000000-0000-4000-8000-000000000001";
const cookie = "dp_anon=runner_test_cookie";

describe("live production smoke runner repair", () => {
  it("constructs one secret-safe direct production generate request without a subprocess", () => {
    const request = liveGenerateRequest(base, sessionId, cookie);
    expect(request).toEqual({
      url: `${base}/api/sessions/${sessionId}?action=generate`,
      init: { method: "POST", headers: { Origin: base, Cookie: cookie } },
    });
  });

  it("dispatches exactly one direct generate fetch", async () => {
    const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ input: String(input), init });
      return new Response(JSON.stringify({ session: { provider: { state: "RUNNING" } } }), { status: 200 });
    }) as typeof fetch;
    const response = await invokeSingleLiveGenerate(base, sessionId, cookie, fakeFetch);
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ input: `${base}/api/sessions/${sessionId}?action=generate`, init: { method: "POST" } });
  });

  it("exercises the no-cost preflight without calling generate", async () => {
    const paths: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input)); paths.push(url.pathname);
      if (url.pathname === "/api/health") return new Response('{"app":"ok"}', { status: 200 });
      if (url.pathname.includes("/asset/")) return new Response(null, { status: 404 });
      if (url.pathname.startsWith("/result")) return new Response("not available", { status: 200 });
      if (url.pathname === "/privacy") return new Response("Perfect Corp YouCam", { status: 200 });
      if (url.pathname === "/how-it-works") return new Response("visual continuity", { status: 200 });
      if (url.pathname === "/try") return new Response("try", { status: 200 });
      return new Response("DrapeProof", { status: 200 });
    }) as typeof fetch;
    const results = await runNoCostProductionChecks(base, fakeFetch);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(paths).not.toContain(`/api/sessions/${sessionId}?action=generate`);
  });

  it.skipIf(process.platform !== "win32")("documents the old Windows npm.cmd path as EINVAL without network activity", async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolveError) => {
      try {
        const child = spawn("npm.cmd", ["--version"], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
        child.once("error", (spawnError) => resolveError(spawnError as NodeJS.ErrnoException));
        child.once("exit", () => resolveError(null));
      } catch (spawnError) {
        resolveError(spawnError as NodeJS.ErrnoException);
      }
    });
    expect(error?.code).toBe("EINVAL");
  });

  it("contains no child-process import or npm shim in the repaired runner source", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../scripts/run-live-production-smoke.ts", import.meta.url), "utf8"));
    expect(source).not.toMatch(/node:child_process/);
    expect(source).not.toMatch(/spawn\s*\(/);
    expect(source).not.toMatch(/npm\.cmd/);
  });
});
