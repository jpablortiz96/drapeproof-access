import { Suspense } from "react";
import { PassportRoute } from "../../src/components/product/passport-route";

export default function PassportPage() { return <Suspense fallback={<main id="main"/>}><PassportRoute/></Suspense>; }
