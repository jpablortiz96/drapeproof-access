import { Suspense } from "react";
import { SessionQueryStep } from "../../../src/components/product/session-query-step";

export default function ReviewPage() { return <Suspense fallback={<main id="main"/>}><SessionQueryStep step="review"/></Suspense>; }
