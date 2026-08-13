import Image from "next/image";
import Link from "next/link";
import { StartTryButton } from "../src/components/product/try-flow";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "DrapeProof — Careful AI virtual try-on",
  description: "Try clothes and accessories with AI, choose what should stay unchanged, and review DrapeProof's visual continuity checks.",
  alternates: { canonical: "/" },
  openGraph: { url: "/", title: "DrapeProof — Try the look. Keep what makes you, you." },
};

export default function Home() {
  return (
    <main id="main" className="product-main">
      <section className="product-hero content-wrap">
        <div className="product-hero-copy">
          <p className="product-kicker">DRAPEPROOF</p>
          <h1>Try the look.<br /><span>Keep what makes you, you.</span></h1>
          <p className="product-lede">Try clothes and accessories with AI. Choose what should stay unchanged. DrapeProof checks the result before you trust it.</p>
          <div className="product-actions"><StartTryButton>Try a look</StartTryButton><Link className="secondary-button" href="/how-it-works">How DrapeProof works</Link></div>
          <p className="plain-disclaimer">Visual verification only — not a physical-fit or safety guarantee.</p>
        </div>
        <div className="hero-transformation" aria-label="Example original and AI result with protected-area checks">
          <figure className="hero-frame hero-original"><Image src="/product/sample-original.png" alt="Original seated portrait before a virtual clothing preview" fill priority sizes="(max-width: 800px) 70vw, 30vw" /><figcaption>Original</figcaption></figure>
          <span className="hero-arrow" aria-hidden="true">→</span>
          <figure className="hero-frame hero-result"><Image src="/product/sample-result.jpg" alt="AI clothing preview with protected-area check callouts" fill priority sizes="(max-width: 800px) 70vw, 30vw" /><figcaption>AI result</figcaption><span className="check-callout callout-one">✓ Control</span><span className="check-callout callout-two">! Armrest</span><span className="check-callout callout-three">✓ Wheel</span></figure>
        </div>
      </section>
      <section className="promise-strip content-wrap" aria-labelledby="promise-title"><p className="product-kicker">A MORE CAREFUL PREVIEW</p><h2 id="promise-title">AI can change the outfit.<br />DrapeProof checks the rest.</h2><div className="promise-grid"><article><span>01</span><h3>Add your look</h3><p>Use your own photo and the clothing or bag you want to try.</p></article><article><span>02</span><h3>Protect what matters</h3><p>Mark a chair, control, tattoo, accessory, or anything else to watch.</p></article><article><span>03</span><h3>Review with context</h3><p>See whether the scene stayed consistent and which areas deserve a closer look.</p></article></div></section>
    </main>
  );
}
