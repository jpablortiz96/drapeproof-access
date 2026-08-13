"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { FeedbackPanel } from "./feedback-panel";
import { fetchSession } from "./session-client";

export function WorkflowPageEvents() {
  const pathname = usePathname(); const searchParams = useSearchParams();
  useEffect(() => {
    let eventName: "landing_viewed" | "protect_step_viewed" | "result_viewed" | "passport_viewed" | null = null;
    let sessionId: string | null = null;
    if (pathname === "/") eventName = "landing_viewed";
    else if (pathname === "/try/protect") { eventName = "protect_step_viewed"; sessionId = new URLSearchParams(location.search).get("session"); }
    else if (pathname === "/result" && (sessionId = searchParams.get("id"))) eventName = "result_viewed";
    else if (pathname === "/passport" && (sessionId = searchParams.get("id"))) eventName = "passport_viewed";
    if (!eventName) return;
    const key = `dp:event:${eventName}:${sessionId ?? pathname}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    const target = eventName === "landing_viewed" ? "/api/health" : `/api/sessions/${encodeURIComponent(sessionId!)}`;
    const body = eventName === "landing_viewed" ? { productEvent: eventName } : { productEvent: eventName };
    void fetch(target, { method: eventName === "landing_viewed" ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => sessionStorage.removeItem(key));
  }, [pathname, searchParams]);
  return null;
}

export function BetaRuntimeUX({ enabled }: { enabled: boolean }) {
  const pathname = usePathname(); const searchParams = useSearchParams(); const resultId = pathname === "/result" ? searchParams.get("id") : null;
  const [showFeedback, setShowFeedback] = useState(false);
  useEffect(() => {
    setShowFeedback(false);
    if (!resultId) return;
    let active = true;
    void fetchSession(resultId).then((session) => { if (active) setShowFeedback(Boolean(session.providerResult && session.finalState !== "PROCESSING")); }).catch(() => undefined);
    return () => { active = false; };
  }, [resultId]);
  return <>{enabled && pathname === "/try/photo" && <aside className="beta-upload-note content-wrap" role="note"><b>Beta preview</b><p>DrapeProof is in beta. AI previews can be imperfect, and visual checks are not physical fit or safety guarantees.</p></aside>}{showFeedback && resultId && <aside className="feedback-shell content-wrap"><FeedbackPanel sessionId={resultId}/></aside>}</>;
}
