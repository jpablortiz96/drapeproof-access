"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";

export function BottomSheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null); const opener = useRef<HTMLElement | null>(null); const titleId = useId();
  useEffect(() => {
    const dialog = ref.current; if (!dialog) return;
    if (open && !dialog.open) { opener.current = document.activeElement as HTMLElement | null; dialog.showModal(); (dialog.querySelector("button") as HTMLElement | null)?.focus(); }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  function close() { onClose(); queueMicrotask(() => opener.current?.focus()); }
  return <dialog ref={ref} className="bottom-sheet" aria-labelledby={titleId} onClose={close} onCancel={(event) => { event.preventDefault(); close(); }}><div className="sheet-handle"/><header><h2 id={titleId}>{title}</h2><button type="button" onClick={close} aria-label="Close dialog">×</button></header>{children}</dialog>;
}
