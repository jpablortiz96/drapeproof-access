import "dotenv/config";
import sharp from "sharp";
import { NeonDatabaseClient } from "../src/product/production/db.js";
import { VercelPrivateObjectStore } from "../src/product/production/blob.js";

const rawBase = process.argv[2] ?? process.env.DRAPEPROOF_SMOKE_URL;
const databaseUrl = process.env.DATABASE_URL?.trim();
const blobToken = process.env.BLOB_READ_WRITE_TOKEN?.trim();
if (!rawBase || !databaseUrl || !blobToken) {
  throw new Error("Usage: smoke:infrastructure <production-url> with DATABASE_URL and BLOB_READ_WRITE_TOKEN configured.");
}

const base = new URL(rawBase).origin;
if (new URL(base).protocol !== "https:") throw new Error("Infrastructure smoke requires an HTTPS production URL.");
const database = new NeonDatabaseClient(databaseUrl);
const objects = new VercelPrivateObjectStore(blobToken);
let sessionId: string | undefined;
let cookie: string | undefined;
let blobKey: string | undefined;

function requireStatus(response: Response, expected: number, step: string): void {
  if (response.status !== expected) throw new Error(`${step} returned ${response.status}, expected ${expected}.`);
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await operation(); } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 750));
    }
  }
  throw lastError;
}

try {
  const create = await fetch(`${base}/api/health`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ action: "create_session" }) });
  requireStatus(create, 201, "Session creation");
  const created = await create.json() as { session?: { id?: string } };
  sessionId = created.session?.id;
  if (!sessionId) throw new Error("Session creation did not return an identifier.");
  const setCookie = create.headers.get("set-cookie") ?? "";
  const ownerCookie = /(?:^|[,;]\s*)dp_anon=([^;]+)/.exec(setCookie)?.[1];
  if (!ownerCookie) throw new Error("Session creation did not return the ownership cookie.");
  cookie = `dp_anon=${ownerCookie}`;

  const image = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 37, g: 81, b: 109 } } }).png().toBuffer();
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(image)], { type: "image/png" }), "infrastructure-smoke.png");
  const upload = await fetch(`${base}/api/sessions/${sessionId}?upload=source`, {
    method: "POST", headers: { Origin: base, Cookie: cookie }, body: form,
  });
  requireStatus(upload, 200, "Private image upload");

  const authorized = await fetch(`${base}/api/sessions/${sessionId}/asset/source`, { headers: { Cookie: cookie } });
  requireStatus(authorized, 200, "Authorized private-media read");
  if (!(authorized.headers.get("content-type") ?? "").startsWith("image/") || (await authorized.arrayBuffer()).byteLength === 0) {
    throw new Error("Authorized private-media read did not return image bytes.");
  }

  const unauthorized = await fetch(`${base}/api/sessions/${sessionId}/asset/source`);
  requireStatus(unauthorized, 404, "Unauthorized private-media read");
  if (!/private.*no-store/i.test(unauthorized.headers.get("cache-control") ?? "")) {
    throw new Error("Unauthorized private-media denial was not marked private/no-store.");
  }

  const beforeDelete = await retry(() => database.query<{ source_blob_key: string | null; deleted_at: string | null }>(
    "SELECT source_blob_key, deleted_at FROM try_on_sessions WHERE id = $1", [sessionId],
  ));
  blobKey = beforeDelete[0]?.source_blob_key ?? undefined;
  if (!blobKey?.startsWith("source/") || beforeDelete[0]?.deleted_at) throw new Error("Neon did not persist the live private source asset.");
  if (!(await retry(() => objects.read(blobKey!))).byteLength) throw new Error("The persisted private Blob was empty.");

  const remove = await fetch(`${base}/api/sessions/${sessionId}`, { method: "DELETE", headers: { Origin: base, Cookie: cookie } });
  requireStatus(remove, 204, "Session deletion");
  const unavailable = await fetch(`${base}/api/sessions/${sessionId}`, { headers: { Cookie: cookie } });
  requireStatus(unavailable, 404, "Deleted-session access");

  const afterDelete = await retry(() => database.query<{ source_blob_key: string | null; deleted_at: string | null }>(
    "SELECT source_blob_key, deleted_at FROM try_on_sessions WHERE id = $1", [sessionId],
  ));
  if (!afterDelete[0]?.deleted_at || afterDelete[0].source_blob_key !== null) throw new Error("Neon did not invalidate the deleted session and clear its Blob reference.");
  let blobRemoved = false;
  try { await objects.read(blobKey); } catch { blobRemoved = true; }
  if (!blobRemoved) throw new Error("The DrapeProof-controlled private Blob still exists after deletion.");

} finally {
  if (sessionId && cookie) {
    await fetch(`${base}/api/sessions/${sessionId}`, { method: "DELETE", headers: { Origin: base, Cookie: cookie } }).catch(() => undefined);
  }
  if (blobKey) await objects.delete([blobKey]).catch(() => undefined);
  if (sessionId) {
    await retry(() => database.query("DELETE FROM try_on_sessions WHERE id = $1", [sessionId]));
    const residue = await retry(() => database.query<{ present: number }>(
      "SELECT 1 AS present FROM try_on_sessions WHERE id = $1", [sessionId],
    ));
    if (residue.length) throw new Error("Infrastructure-smoke database cleanup did not complete.");
  }
}

process.stdout.write("PASS: real Neon CRUD, private Blob write/read/delete, owner authorization, database invalidation, and smoke-artifact cleanup verified without a provider call.\n");
