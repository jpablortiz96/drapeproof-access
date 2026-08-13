"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { PublicTryOnSession, SessionStage } from "@drapeproof/product/live/types";
import { ErrorState, PrimaryButton } from "./ui";
import { fetchSession } from "./session-client";

const order: SessionStage[] = ["CREATING", "CONTINUITY", "REGIONS", "FACE", "COMPLETE"];

export function ProcessingExperience({ sessionId }: { sessionId: string }) {
  const router = useRouter(); const [session, setSession] = useState<PublicTryOnSession | null>(null); const [networkError, setNetworkError] = useState("");
  const advance = useCallback(async () => { try { setNetworkError(""); const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?action=process`, { method: "POST" }); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? "The session could not be refreshed."); setSession(data.session); if (data.session.finalState !== "PROCESSING") router.replace(`/result?id=${encodeURIComponent(sessionId)}`); } catch { setNetworkError("Connection lost. Your progress is saved on this device; try again when you’re online."); } }, [router, sessionId]);
  useEffect(() => { fetchSession(sessionId).then((record) => { setSession(record); if (record.finalState !== "PROCESSING") router.replace(`/result?id=${encodeURIComponent(sessionId)}`); }).catch((reason) => setNetworkError(reason.message)); }, [router, sessionId]);
  useEffect(() => { if (!session || session.finalState !== "PROCESSING") return; const timer = window.setTimeout(advance, 1800); return () => window.clearTimeout(timer); }, [session, advance]);
  if (networkError && !session) return <main id="main"><ErrorState title="We can’t reach this try-on">{networkError}<PrimaryButton onClick={advance}>Try again</PrimaryButton></ErrorState></main>;
  const current = session ? Math.max(0, order.indexOf(session.stage)) : 0;
  const stages = [
    { key: "CREATING", label: "Creating your look", show: true },
    { key: "CONTINUITY", label: "Checking scene consistency", show: true },
    { key: "REGIONS", label: "Checking protected areas", show: Boolean(session?.protectedRegions.length) },
    { key: "FACE", label: "Checking face appearance", show: Boolean(session?.faceAppearance.enabled) },
    { key: "COMPLETE", label: "Preparing your DrapeProof result", show: true },
  ].filter((item) => item.show);
  return <main id="main" className="processing-page"><section className="processing-visual" aria-hidden="true">{session?.assetUrls.source ? <img src={session.assetUrls.source} alt=""/> : <div/>}<span className="processing-scan"/></section><section className="processing-copy" aria-live="polite"><p className="product-kicker">YOUR PREVIEW IS IN PROGRESS</p><h1>{session?.stage === "CREATING" ? "Making the change carefully." : "Checking what stayed true."}</h1><p>You can leave this page and return from Passports on this device.</p><ol>{stages.map((item) => { const index = order.indexOf(item.key as SessionStage); const state = index < current ? "done" : index === current ? "active" : "waiting"; return <li className={state} key={item.key}><span aria-hidden="true">{state === "done" ? "✓" : state === "active" ? "•" : ""}</span><b>{item.label}</b><small>{state === "done" ? "Complete" : state === "active" ? "In progress" : "Waiting"}</small></li>; })}</ol>{networkError && <div className="network-state" role="alert"><p>{networkError}</p><PrimaryButton onClick={advance}>Retry</PrimaryButton></div>}</section></main>;
}
