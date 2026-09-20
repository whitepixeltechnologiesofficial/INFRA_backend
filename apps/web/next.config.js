/** @type {import('next').NextConfig} */
const nextConfig = {
  // packages/* are consumed as TS source directly (see tsconfig "paths"
  // via workspace symlinks) — no transpilePackages needed as long as
  // @wpt/shared, @wpt/api-client, @wpt/crypto stay TS-source-only.
  transpilePackages: ["@wpt/shared", "@wpt/api-client", "@wpt/crypto"],
  // static verification for @wpt/web is the offline `scripts/source-lint.js`
  // gate (run via `pnpm lint`) + `tsc --noEmit` (`pnpm typecheck`); the
  // monorepo root ESLint config is unrelated to this app and doesn't resolve
  // its plugins here, so Next's built-in lint pass is disabled.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
