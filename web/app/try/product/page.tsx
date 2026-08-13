import { Suspense } from "react";
import { SessionQueryStep } from "../../../src/components/product/session-query-step";

export default function ProductPage() { return <Suspense fallback={<main id="main"/>}><SessionQueryStep step="product"/></Suspense>; }
