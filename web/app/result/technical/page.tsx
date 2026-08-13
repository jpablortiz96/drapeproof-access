import { Suspense } from "react";
import { ResultRoute } from "../../../src/components/product/result-route";

export default function TechnicalPage() { return <Suspense fallback={<main id="main"/>}><ResultRoute technical/></Suspense>; }
