"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { PublicTryOnSession } from "@drapeproof/product/live/types";
import { fetchSession } from "./session-client";
import { ResultView } from "./result-view";
import { TechnicalView } from "./technical-view";
import { ErrorState } from "./ui";

export function ResultRoute({ technical = false }: { technical?: boolean }) {
  const id = useSearchParams().get("id") ?? "";
  const [session, setSession] = useState<PublicTryOnSession | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => { if (!id) { setUnavailable(true); return; } fetchSession(id).then(setSession).catch(() => setUnavailable(true)); }, [id]);
  if (unavailable) return <main id="main"><ErrorState title={technical ? "Technical details are unavailable" : "This result is no longer available"}>{technical ? "This session may have expired or been deleted." : "It may have expired or been deleted. Start a new try-on whenever you’re ready."}<Link className="primary-button" href="/try">Start a try-on</Link></ErrorState></main>;
  if (!session) return <main id="main"><h1 className="visually-hidden">Loading your result</h1><p role="status">Loading your result…</p></main>;
  return technical ? <TechnicalView session={session}/> : <ResultView session={session}/>;
}
