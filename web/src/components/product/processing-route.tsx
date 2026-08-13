"use client";
import { useSearchParams } from "next/navigation";
import { ProcessingExperience } from "./processing-experience";

export function ProcessingRoute() {
  const query = useSearchParams();
  const sessionId = query.get("id") ?? "";
  return <ProcessingExperience sessionId={sessionId}/>;
}
