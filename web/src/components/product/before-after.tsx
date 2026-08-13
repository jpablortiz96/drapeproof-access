"use client";
import { useState } from "react";

type OverlayRegion = { id: string; label: string; polygon: Array<{ x: number; y: number }> };

export function BeforeAfter({ before, after, regions = [], afterLabel = "AI result" }: { before: string; after: string; regions?: OverlayRegion[]; afterLabel?: string }) {
  const [position, setPosition] = useState(52);
  return <div className="before-after"><div className="before-after-media"><img src={before} alt="Original image before the AI preview"/><div className="after-layer" style={{ clipPath: `inset(0 0 0 ${position}%)` }}><img src={after} alt={`${afterLabel} preview`}/>{regions.length > 0 && <svg className="comparison-overlays" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">{regions.map((region, index) => <g key={region.id}><polygon points={region.polygon.map((point) => `${point.x},${point.y}`).join(" ")}/><text x={region.polygon[0]!.x} y={region.polygon[0]!.y}>{index + 1}</text></g>)}</svg>}</div><span className="comparison-label label-before">Original</span>{afterLabel === "AI result" ? <span className="comparison-label label-after">AI result</span> : <span className="comparison-label label-after">{afterLabel}</span>}<i style={{ left: `${position}%` }} aria-hidden="true"><span>↔</span></i></div><label><span>Compare original and {afterLabel.toLowerCase()}</span><input aria-label={`Show more original or ${afterLabel.toLowerCase()}`} type="range" min="0" max="100" value={position} onChange={(event) => setPosition(Number(event.target.value))}/></label><p className="visually-hidden">The comparison shows your original photo beside the {afterLabel.toLowerCase()} version. The slider changes how much of each image is visible.</p></div>;
}
