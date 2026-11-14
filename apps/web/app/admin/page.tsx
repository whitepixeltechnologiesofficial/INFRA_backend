// Admin Dashboard, per §5: lives inside @wpt/web as a hidden route (not
// its own app, not linked from primary nav). "Hidden" here only means
// "not linked" — it is NOT an access control mechanism. Before this ships,
// it needs real auth (e.g. middleware.ts checking an admin role/claim on
// every /admin/* request), otherwise it's just an obscure URL.

import type { JSX } from "react";

export default function AdminDashboardPage(): JSX.Element {
  return <main>@wpt/web — admin (unlinked, auth TODO)</main>;
}
