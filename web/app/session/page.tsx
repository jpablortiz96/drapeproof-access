import { Suspense } from "react";
import { ProcessingRoute } from "../../src/components/product/processing-route";

export default function SessionPage() { return <Suspense fallback={<main id="main"/>}><ProcessingRoute/></Suspense>; }
