"use client";
import { useSearchParams } from "next/navigation";
import { PhotoStep } from "./photo-step";
import { ProductStep } from "./product-step";
import { ProtectStep } from "./protect-step";
import { ReviewStep } from "./review-step";

export function SessionQueryStep({ step }: { step: "photo" | "product" | "protect" | "review" }) {
  const sessionId = useSearchParams().get("session") ?? "";
  if (step === "photo") return <PhotoStep sessionId={sessionId}/>;
  if (step === "product") return <ProductStep sessionId={sessionId}/>;
  if (step === "protect") return <ProtectStep sessionId={sessionId}/>;
  return <ReviewStep sessionId={sessionId}/>;
}
