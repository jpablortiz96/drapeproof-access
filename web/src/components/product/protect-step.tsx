"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { PublicTryOnSession, UserProtectedRegion } from "@drapeproof/product/live/types";
import { ErrorState, FlowTopBar, PrimaryButton } from "./ui";
import { ProtectedRegionEditor } from "./protected-region-editor";
import { fetchSession, patchSession } from "./session-client";

export function ProtectStep({ sessionId }: { sessionId: string }) {
  const router = useRouter(); const [session, setSession] = useState<PublicTryOnSession | null>(null); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  useEffect(() => { if (sessionId) fetchSession(sessionId).then(setSession).catch((reason) => setError(reason.message)); }, [sessionId]);
  async function save(regions: UserProtectedRegion[]) { setSaving(true); setError(""); try { await patchSession(sessionId, { protectedRegions: regions }); router.push(`/try/review?session=${encodeURIComponent(sessionId)}`); } catch (reason) { setError(reason instanceof Error ? reason.message : "The protected areas could not be saved."); setSaving(false); } }
  if (!sessionId || error && !session) return <main id="main"><ErrorState title="This try-on is unavailable">{error || "Start a new try-on to continue."}<PrimaryButton onClick={() => router.push("/try")}>Start over</PrimaryButton></ErrorState></main>;
  if (!session?.assetUrls.source) return <main id="main"><ErrorState title="Add your photo first">Protected areas are drawn on your photo.<PrimaryButton onClick={() => router.push(`/try/photo?session=${encodeURIComponent(sessionId)}`)}>Add photo</PrimaryButton></ErrorState></main>;
  return <main id="main" className="flow-page protect-flow"><FlowTopBar step="Step 3 of 4" title="Protected areas" backHref={`/try/product?session=${encodeURIComponent(sessionId)}`}/><div className="flow-content"><div className="flow-heading"><h1>What should AI never change?</h1><p>Mark anything you want DrapeProof to keep an eye on. You can create more than one area.</p><aside className="preserve-note"><b>Preserve Mode</b><span>Restore from original when possible.</span><p>DrapeProof only offers restoration when it can avoid the look you asked AI to create. Nothing is restored automatically.</p></aside></div>{error && <p className="inline-error" role="alert">{error}</p>}<ProtectedRegionEditor imageUrl={session.assetUrls.source} initialRegions={session.protectedRegions} saving={saving} onContinue={save} onSkip={() => save([])}/><p className="skip-explanation">If you skip, DrapeProof can still check whether the overall scene stayed consistent, but protected-area verification will not run.</p></div></main>;
}
