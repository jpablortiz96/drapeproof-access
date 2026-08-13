const args = process.argv.slice(2);
const liveProvider = args.includes("--live-provider");
const baseArgument = args.find((arg) => !arg.startsWith("--")) ?? process.env.DRAPEPROOF_SMOKE_URL;
if (!baseArgument) throw new Error("Usage: npm run smoke:production -- https://your-deployment.example [--live-provider]");
const base = new URL(baseArgument).origin;

interface Check { name: string; path: string; status: number[]; contains?: RegExp; }
const checks: Check[] = [
  { name: "homepage", path: "/", status: [200], contains: /DrapeProof/i },
  { name: "try", path: "/try", status: [200], contains: /try/i },
  { name: "health", path: "/api/health", status: [200], contains: /"app":"ok"/ },
  { name: "privacy", path: "/privacy", status: [200], contains: /Preserve Mode/i },
  { name: "how-it-works", path: "/how-it-works", status: [200], contains: /visual continuity/i },
  { name: "private-media-rejection", path: "/api/sessions/00000000-0000-4000-8000-000000000000/asset/source", status: [404] },
  { name: "private-preserved-media-rejection", path: "/api/sessions/00000000-0000-4000-8000-000000000000/asset/preserved", status: [404] },
  { name: "not-found-result-shell", path: "/result?id=00000000-0000-4000-8000-000000000000", status: [200, 404] },
];

let failed = 0;
for (const check of checks) {
  const response = await fetch(`${base}${check.path}`, { redirect: "manual" });
  const body = await response.text();
  const ok = check.status.includes(response.status) && (!check.contains || check.contains.test(body));
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${check.name} (${response.status})\n`);
  if (!ok) failed += 1;
}

if (liveProvider) {
  const id = process.env.DRAPEPROOF_SMOKE_SESSION_ID;
  const cookie = process.env.DRAPEPROOF_SMOKE_COOKIE;
  if (!id || !cookie) throw new Error("--live-provider requires DRAPEPROOF_SMOKE_SESSION_ID and DRAPEPROOF_SMOKE_COOKIE for a reviewed, ready session.");
  const response = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}?action=generate`, { method: "POST", headers: { Origin: base, Cookie: `dp_anon=${cookie}` } });
  process.stdout.write(`${response.ok ? "PASS" : "FAIL"} explicit live provider start (${response.status})\n`);
  if (!response.ok) failed += 1;
}
if (failed) process.exitCode = 1;
