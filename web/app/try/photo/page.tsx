import { Suspense } from "react";
import { SessionQueryStep } from "../../../src/components/product/session-query-step";

export default function PhotoPage() { return <Suspense fallback={<main id="main"/>}><SessionQueryStep step="photo"/></Suspense>; }
