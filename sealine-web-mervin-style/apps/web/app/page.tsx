import { LinkingScreen } from "../components/LinkingScreen";
import { Suspense } from "react";

export default function Page() {
  return <Suspense fallback={<div className="page">Loading…</div>}><LinkingScreen /></Suspense>;
}
