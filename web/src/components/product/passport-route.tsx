"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { PublicTryOnSession } from "@drapeproof/product/live/types";
import { fetchSession } from "./session-client";
import { PassportCard } from "./passport-card";
import { ErrorState } from "./ui";

export function PassportRoute() {
  const id = useSearchParams().get("id") ?? "";
  const [session, setSession] = useState<PublicTryOnSession | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => { if (!id) { setUnavailable(true); return; } fetchSession(id).then((record) => record.providerResult ? setSession(record) : setUnavailable(true)).catch(() => setUnavailable(true)); }, [id]);
  if (unavailable) return <main id="main"><ErrorState title="This Passport is not available">It may still be processing, or the session may have expired.<Link className="primary-button" href="/passports">View Passports</Link></ErrorState></main>;
  if (!session) return <main id="main"><p role="status">Loading your Passport…</p></main>;
  return <main id="main" className="passport-page content-wrap">{session.qaFixture && <aside className="qa-fixture-banner" role="note"><b>UI QA fixture</b><span>Uses historical reference images. No new provider event or provider unit.</span></aside>}<div className="passport-heading"><p className="product-kicker">YOUR DRAPEPROOF PASSPORT</p><h1>A clear record of what was checked.</h1></div><PassportCard session={session}/><div className="passport-links"><Link href={`/result?id=${encodeURIComponent(id)}`}>Back to result</Link><Link href={`/result/technical?id=${encodeURIComponent(id)}`}>View technical evidence</Link></div></main>;
}
