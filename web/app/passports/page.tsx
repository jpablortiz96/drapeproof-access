import { Suspense } from "react";
import { PassportLibrary } from "../../src/components/product/passport-library";

export default function PassportsPage() { return <Suspense fallback={<main id="main"/>}><PassportLibrary/></Suspense>; }
