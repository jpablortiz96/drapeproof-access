"use client";
import { useState } from "react";

const reasons = [
  ["TRY_ON_UNREALISTIC", "The try-on looked unrealistic"],
  ["PROTECTED_AREAS_UNCLEAR", "I didn’t understand protected areas"],
  ["RESTORE_MORE", "I wanted DrapeProof to restore more"],
  ["TOO_SLOW", "The process took too long"],
  ["REUSE_PROTECTED_AREAS", "I wanted to reuse my protected areas"],
  ["SOMETHING_ELSE", "Something else"],
] as const;

export function FeedbackPanel({ sessionId }: { sessionId: string }) {
  const [useful, setUseful] = useState<boolean | null>(null); const [reason, setReason] = useState("");
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false); const [error, setError] = useState("");
  async function submit() {
    if (useful === null || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedback: { useful, reason: reason || null, somethingElse: reason === "SOMETHING_ELSE" ? note : null } }) });
      const data = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message ?? "Feedback could not be saved.");
      setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Feedback could not be saved."); setBusy(false); }
  }
  if (done) return <section className="feedback-card feedback-success" role="status"><span aria-hidden="true">✓</span><div><b>Thank you.</b><p>Your feedback was saved with this beta session.</p></div></section>;
  return <section className="feedback-card" aria-labelledby="feedback-title"><div className="feedback-heading"><span>Beta feedback</span><h2 id="feedback-title">Was DrapeProof useful?</h2><p>A quick answer helps us decide what to improve next.</p></div><div className="feedback-choice" role="group" aria-label="Was DrapeProof useful?"><button type="button" aria-pressed={useful === true} onClick={() => setUseful(true)}>Yes</button><button type="button" aria-pressed={useful === false} onClick={() => setUseful(false)}>Not really</button></div>{useful !== null && <div className="feedback-reasons"><fieldset><legend>What would have made this better? <small>Optional</small></legend>{reasons.map(([value, label]) => <label key={value}><input type="radio" name="feedback-reason" value={value} checked={reason === value} onChange={() => { setReason(value); if (value !== "SOMETHING_ELSE") setNote(""); }}/><span>{label}</span></label>)}</fieldset>{reason === "SOMETHING_ELSE" && <label className="feedback-note"><span>Tell us briefly <small>Optional</small></span><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={240} rows={3} placeholder="Please don’t include health or disability information."/><small>{note.length}/240</small></label>}<button className="primary-button" type="button" disabled={busy} onClick={submit}>{busy ? "Sending…" : "Send feedback"}</button></div>}{error && <p className="inline-error" role="alert">{error}</p>}</section>;
}
