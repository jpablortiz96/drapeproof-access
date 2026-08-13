"use client";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { PrimaryButton } from "./ui";

export function StartTryButton({ children = "Start try-on" }: { children?: ReactNode }) {
  const router = useRouter(); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  async function start() { setLoading(true); setError(""); try { const response = await fetch("/api/health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create_session" }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? "A new try-on could not be started."); router.push(`/try/photo?session=${encodeURIComponent(data.session.id)}`); } catch (reason) { setError(reason instanceof Error ? reason.message : "A new try-on could not be started."); setLoading(false); } }
  return <div><PrimaryButton type="button" onClick={start} disabled={loading}>{loading ? "Starting…" : children}</PrimaryButton>{error && <p className="inline-error" role="alert">{error}</p>}</div>;
}
