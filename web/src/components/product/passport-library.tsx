"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { PublicTryOnSession } from "@drapeproof/product/live/types";
import { EmptyState, StatusBadge } from "./ui";

export function PassportLibrary() {
  const deleted = useSearchParams().has("deleted");
  const [records, setRecords] = useState<PublicTryOnSession[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/health?view=sessions", { cache: "no-store" })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error("Passports could not be loaded."); return data.sessions as PublicTryOnSession[]; })
      .then(setRecords).catch((reason) => setError(reason instanceof Error ? reason.message : "Passports could not be loaded."));
  }, []);
  return <main id="main" className="library-page content-wrap">
    <div className="library-heading"><p className="product-kicker">THIS DEVICE</p><h1>Your Passports</h1><p>Anonymous sessions saved in this browser are available here for up to 24 hours.</p>{deleted && <p className="success-message" role="status">Session deleted.</p>}</div>
    {error ? <EmptyState title="Passports are temporarily unavailable">Try again in a moment.</EmptyState> : records === null ? <p role="status">Loading your Passports…</p> : !records.length ? <EmptyState title="No Passports yet">Create a try-on and your completed DrapeProof result will appear here.<Link className="primary-button" href="/try">Try a look</Link></EmptyState> : <div className="passport-library">{records.map((session) => <Link href={session.finalState === "PROCESSING" ? `/session?id=${encodeURIComponent(session.id)}` : session.providerResult ? `/passport?id=${encodeURIComponent(session.id)}` : `/result?id=${encodeURIComponent(session.id)}`} key={session.id}><div>{session.providerResult ? <img src={`/api/sessions/${session.id}/asset/${session.preservedResult ? "preserved" : "result"}?display=1`} alt=""/> : <span aria-hidden="true">&hellip;</span>}</div><section><small>{new Date(session.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small><h2>{session.category === "CLOTHING" ? "Clothing try-on" : session.category === "BAG" ? "Bag try-on" : "New try-on"}</h2><StatusBadge state={session.finalState === "READY_VERIFIED" ? "success" : session.finalState === "READY_WITH_REVIEW" ? "review" : session.finalState === "PROCESSING" ? "processing" : "error"}>{session.finalState === "READY_VERIFIED" ? "Ready" : session.finalState === "READY_WITH_REVIEW" ? "Ready with review" : session.finalState === "PROCESSING" ? "Processing" : "Needs attention"}</StatusBadge></section><span aria-hidden="true">&rarr;</span></Link>)}</div>}
  </main>;
}
