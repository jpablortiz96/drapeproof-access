"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { PublicTryOnSession } from "@drapeproof/product/live/types";
import { ErrorState, FlowTopBar, PrimaryButton, SecondaryButton } from "./ui";
import { fetchSession, uploadSessionImage } from "./session-client";

export function PhotoStep({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const camera = useRef<HTMLInputElement>(null); const chooser = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState<PublicTryOnSession | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (sessionId) fetchSession(sessionId).then(setSession).catch((reason) => setError(reason.message)); }, [sessionId]);
  async function select(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(""); const local = URL.createObjectURL(file); setPreview(local);
    try { setSession(await uploadSessionImage(sessionId, "source", file)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The photo could not be added."); setPreview(null); }
    finally { setBusy(false); }
  }
  if (!sessionId || error && !session) return <main id="main"><ErrorState title="Start with a new try-on">{error || "This link does not include a try-on session."}<PrimaryButton onClick={() => router.push("/try")}>Start over</PrimaryButton></ErrorState></main>;
  const photo = preview ?? session?.assetUrls.source;
  return <main id="main" className="flow-page"><FlowTopBar step="Step 1 of 4" title="Your photo" backHref="/try"/><div className="flow-content"><div className="flow-heading"><h1>Add your photo</h1><p>Use a clear photo where your body and anything you want to protect are visible. You do not need to be standing.</p></div><div className="flow-grid"><section className={`upload-dropzone ${photo ? "has-preview" : ""}`} aria-label="Photo preview">{photo ? <img src={photo} alt="Your selected try-on photo" /> : <div><span aria-hidden="true">＋</span><b>Your photo appears here</b><p>JPG, PNG, or WebP · up to 4 MB</p></div>}</section><aside className="support-pane"><h2>{photo ? "Photo added" : "Choose a photo"}</h2><p>Good light and a clear view of the areas you care about will help DrapeProof compare the result.</p><input ref={camera} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" aria-label="Take a photo" onChange={(event) => select(event.target.files?.[0])}/><input ref={chooser} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose a photo" onChange={(event) => select(event.target.files?.[0])}/><PrimaryButton type="button" disabled={busy} onClick={() => camera.current?.click()}>{busy ? "Adding photo…" : "Take photo"}</PrimaryButton><SecondaryButton type="button" disabled={busy} onClick={() => chooser.current?.click()}>{photo ? "Replace photo" : "Choose photo"}</SecondaryButton>{error && <p className="inline-error" role="alert">{error}</p>}{photo && <PrimaryButton type="button" onClick={() => router.push(`/try/product?session=${encodeURIComponent(sessionId)}`)}>Continue</PrimaryButton>}<p className="context-note"><b>Before you upload</b>Your sanitized image is stored in a private anonymous session and sent to our processing provider only when you generate the preview. <a href="/privacy">Privacy details</a></p></aside></div></div></main>;
}
