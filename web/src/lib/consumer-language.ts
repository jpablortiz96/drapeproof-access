const reasonLanguage: Record<string, string> = {
  ASPECT_RATIO_SHIFT: "The result frame has a different shape from the original.",
  NONUNIFORM_SCALE_REQUIRED: "The result would need uneven scaling to align with the original.",
  POSE_LANDMARK_LOSS: "Important pose reference points were no longer visible.",
  POSE_GEOMETRY_SHIFT: "The detected pose geometry shifted beyond the comparison policy.",
  BODY_FRAMING_SHIFT: "The person occupies the frame differently.",
  INSUFFICIENT_FEATURE_MATCHES: "Too few stable visual points matched between images.",
  LOW_GEOMETRIC_INLIER_RATIO: "Too few candidate matches agreed on one geometric relationship.",
  NO_STABLE_TRANSFORM: "A stable scene transform could not be estimated.",
  LOCAL_CHECK_UNAVAILABLE: "The local continuity engine could not complete this comparison.",
  VERIFIER_RUNTIME_UNAVAILABLE: "The visual-check runtime was unavailable for this comparison.",
  VERIFIER_ASSET_MISSING: "A required visual-check resource was unavailable.",
  VERIFIER_INPUT_UNAVAILABLE: "The source or result image could not be loaded for visual checking.",
  VERIFIER_EXECUTION_FAILED: "The visual-check engine could not complete this comparison.",
  REGION_ALIGNMENT_FAILED: "The overall scene was comparable, but the protected areas could not be aligned reliably.",
  NO_PROTECTED_REGIONS: "No protected areas were requested for this result.",
};

export function continuityReason(code: string): string {
  return reasonLanguage[code] ?? "This signal contributed to the continuity decision.";
}

export function continuityHeadline(state: "NOT_CHECKED" | "CHECKING" | "CONSISTENT" | "NEEDS_REVIEW" | "CHANGED_TOO_MUCH" | "UNAVAILABLE"): string {
  if (state === "CONSISTENT") return "Scene looks consistent";
  if (state === "CHANGED_TOO_MUCH") return "This preview changed too much";
  if (state === "NEEDS_REVIEW") return "Some visual changes need review";
  if (state === "CHECKING") return "Checking scene consistency";
  return "Not available";
}
