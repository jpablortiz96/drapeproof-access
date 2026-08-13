"use client";
import { useEffect } from "react";

export function ProductEventBeacon({ eventName, sessionId }: { eventName: "landing_viewed" | "protect_step_viewed" | "result_viewed" | "passport_viewed"; sessionId?: string }) {
  useEffect(() => {
    const key = `dp:event:${eventName}:${sessionId ?? location.pathname}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
    const target = eventName === "landing_viewed" ? "/api/health" : `/api/sessions/${encodeURIComponent(sessionId!)}`;
    void fetch(target, { method: eventName === "landing_viewed" ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productEvent: eventName }), keepalive: true }).catch(() => sessionStorage.removeItem(key));
  }, [eventName, sessionId]);
  return null;
}
