import type { PublicTryOnSession } from "@drapeproof/product/live/types";

export interface ApiFailure { error?: { message?: string; action?: string } }

export async function fetchSession(id: string): Promise<PublicTryOnSession> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { cache: "no-store" });
  const data = await response.json() as { session?: PublicTryOnSession } & ApiFailure;
  if (!response.ok || !data.session) throw new Error(data.error?.message ?? "This try-on session is not available.");
  return data.session;
}

export async function patchSession(id: string, body: object): Promise<PublicTryOnSession> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json() as { session?: PublicTryOnSession } & ApiFailure;
  if (!response.ok || !data.session) throw new Error(data.error?.message ?? "Your changes could not be saved.");
  return data.session;
}

export async function uploadSessionImage(id: string, kind: "source" | "product", file: File): Promise<PublicTryOnSession> {
  const form = new FormData(); form.set("image", file);
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}?upload=${kind}`, { method: "POST", body: form });
  const data = await response.json() as { session?: PublicTryOnSession } & ApiFailure;
  if (!response.ok || !data.session) throw new Error(data.error?.message ?? "The image could not be uploaded.");
  return data.session;
}
