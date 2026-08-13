import Link from "next/link";
import { Suspense, type ButtonHTMLAttributes, type ReactNode } from "react";
import { BetaRuntimeUX, WorkflowPageEvents } from "./beta-runtime";

export function AppShell({ children, betaMode = false }: { children: ReactNode; betaMode?: boolean }) {
  return <><Suspense fallback={null}><WorkflowPageEvents/></Suspense><a className="product-skip" href="#main">Skip to main content</a><header className="product-topbar"><Link className="product-logo" href="/" aria-label="DrapeProof home"><span aria-hidden="true">D</span><b>DRAPEPROOF</b>{betaMode && <i className="beta-badge">Beta</i>}</Link><nav aria-label="Primary navigation"><Link href="/">Home</Link><Link href="/try">Try</Link><Link href="/passports">Passports</Link><Link className="desktop-method" href="/how-it-works">How it works</Link></nav></header><Suspense fallback={null}><BetaRuntimeUX enabled={betaMode}/></Suspense>{children}<footer className="product-footer"><div><b>DRAPEPROOF</b><p>Try the look. Keep what makes you, you.</p></div><div><Link href="/how-it-works">How it works</Link><Link href="/privacy">Privacy</Link></div></footer><nav className="bottom-nav" aria-label="Mobile navigation"><Link href="/"><span aria-hidden="true">⌂</span>Home</Link><Link href="/try"><span aria-hidden="true">＋</span>Try</Link><Link href="/passports"><span aria-hidden="true">◇</span>Passports</Link></nav></>;
}

export function PrimaryButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) { return <button className={`primary-button ${className}`} {...props} />; }
export function SecondaryButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) { return <button className={`secondary-button ${className}`} {...props} />; }

export function StatusBadge({ state, children }: { state: "success" | "review" | "error" | "neutral" | "processing"; children: ReactNode }) {
  const symbol = state === "success" ? "✓" : state === "review" ? "!" : state === "error" ? "×" : state === "processing" ? "…" : "—";
  return <span className={`product-status status-${state}`}><span aria-hidden="true">{symbol}</span>{children}</span>;
}

export function MediaCard({ children, className = "" }: { children: ReactNode; className?: string }) { return <div className={`media-card ${className}`}>{children}</div>; }

export function FlowTopBar({ step, title, backHref }: { step: string; title: string; backHref?: string }) {
  return <div className="flow-topbar">{backHref ? <Link className="flow-back" href={backHref} aria-label="Go back">←</Link> : <span />}<div><span>{step}</span><b>{title}</b></div><Link href="/" aria-label="Close try-on">×</Link></div>;
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <section className="empty-state"><span aria-hidden="true">◇</span><h1>{title}</h1><p>{children}</p>{action}</section>; }
export function ErrorState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <section className="empty-state error-state" role="alert"><span aria-hidden="true">!</span><h1>{title}</h1><p>{children}</p>{action}</section>; }

export function TechnicalDisclosure({ title = "View details", children }: { title?: string; children: ReactNode }) { return <details className="technical-disclosure"><summary>{title}<span aria-hidden="true">＋</span></summary><div>{children}</div></details>; }
