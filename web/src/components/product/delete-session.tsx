"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BottomSheet } from "./bottom-sheet";
import { SecondaryButton } from "./ui";

export function DeleteSession({ id }: { id: string }) {
  const router = useRouter(); const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function remove() { setBusy(true); setError(""); const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }); if (!response.ok) { setError("This session could not be deleted. Try again."); setBusy(false); return; } router.replace("/passports?deleted=1"); router.refresh(); }
  return <><button className="danger-link" type="button" onClick={() => setOpen(true)}>Delete this session</button><BottomSheet open={open} onClose={() => setOpen(false)} title="Delete this session?"><div className="sheet-content"><p>This removes the photo, product, AI result, preserved derivatives, repair crops and traces, verification evidence, and Passport stored by DrapeProof. This action cannot be undone.</p>{error && <p className="inline-error" role="alert">{error}</p>}<button className="danger-button" type="button" disabled={busy} onClick={remove}>{busy ? "Deleting…" : "Delete permanently"}</button><SecondaryButton type="button" onClick={() => setOpen(false)}>Keep session</SecondaryButton></div></BottomSheet></>;
}
