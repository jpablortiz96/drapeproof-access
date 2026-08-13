import { Suspense } from "react";
import { ResultRoute } from "../../src/components/product/result-route";

export default function ResultPage() { return <Suspense fallback={<main id="main"/>}><ResultRoute/></Suspense>; }
