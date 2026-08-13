import { StartTryButton } from "../../src/components/product/try-flow";

export default function TryPage() {
  return <main id="main" className="product-main"><section className="try-entry content-wrap"><div><p className="product-kicker">YOUR TRY-ON</p><h1>A preview that checks what matters to you.</h1><p>Add a photo, choose a look, and mark anything you want DrapeProof to keep an eye on.</p><StartTryButton>Start try-on</StartTryButton><small>No account required</small></div><div className="try-entry-steps"><article><span>1</span><b>Add your photo</b><p>Standing, seated, or your natural pose.</p></article><article><span>2</span><b>Choose your look</b><p>Upload clothing or a bag image.</p></article><article><span>3</span><b>Protect what matters</b><p>Mark one or more areas, or skip.</p></article></div></section></main>;
}
