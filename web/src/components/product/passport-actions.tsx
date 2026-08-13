"use client";
import { useState } from "react";

export function PassportActions({ id }: { id: string }) {
  const [message, setMessage] = useState("");
  function recordDownload() { return fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productEvent: "passport_downloaded" }), keepalive: true }).catch(() => undefined); }
  async function share() {
    setMessage("");
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/asset/passport`, { cache: "no-store" });
      if (!response.ok) throw new Error("Passport unavailable");
      void recordDownload();
      const file = new File([await response.blob()], `drapeproof-${id.slice(0, 8)}.png`, { type: "image/png" });
      if (navigator.share && navigator.canShare?.({ files: [file] })) await navigator.share({ title: "My DrapeProof Passport", text: "My visual try-on verification", files: [file] });
      else {
        const url = URL.createObjectURL(file); const link = document.createElement("a"); link.href = url; link.download = file.name; link.click(); URL.revokeObjectURL(url);
        setMessage("Passport image downloaded — share the file wherever you choose.");
      }
    } catch { setMessage("Sharing was cancelled or unavailable."); }
  }
  return <div className="passport-actions"><button className="primary-button" type="button" onClick={share}>Share</button><a className="secondary-button" href={`/api/sessions/${encodeURIComponent(id)}/asset/passport`} download onClick={() => void recordDownload()}>Save image</a>{message && <span role="status">{message}</span>}</div>;
}
