/** @type {import('next').NextConfig} */
const nextConfig = {
  // packages/* are consumed as TS source directly (see tsconfig "paths"
  // via workspace symlinks) — no transpilePackages needed as long as
  // @wpt/shared, @wpt/api-client, @wpt/crypto stay TS-source-only.
  transpilePackages: ["@wpt/shared", "@wpt/api-client", "@wpt/crypto"],
  // The dev server is bound to 0.0.0.0 (see the `dev` script) so a phone on the
  // same LAN can load the dev test-login URL. Next blocks cross-origin dev
  // requests unless the requesting origin is allowed, so a developer's own LAN
  // address has to be permitted. `*.local` covers the mDNS form most routers hand
  // out; add your own host here if you use another name.
  allowedDevOrigins: ["*.local", "192.168.*.*", "10.*.*.*", "172.16.*.*", "172.17.*.*", "172.18.*.*", "172.19.*.*", "172.2*.*.*", "172.30.*.*", "172.31.*.*"],
  // static verification for @wpt/web is the offline `scripts/source-lint.js`
  // gate (run via `pnpm lint`) + `tsc --noEmit` (`pnpm typecheck`); the
  // monorepo root ESLint config is unrelated to this app and doesn't resolve
  // its plugins here, so Next's built-in lint pass is disabled.
  eslint: { ignoreDuringBuilds: true },
  // @wpt/shared re-exports its TS modules with Node-ESM ".js" specifiers
  // (correct for tsc/Bundler, tsx and future Node type-stripping). webpack
  // resolves those requests literally, so alias ".js" back into the actual
  // ".ts" sources that Next compiles via transpilePackages.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias || {}),
      ".js": [".ts", ".js"],
    };
    return config;
  },
};

export default nextConfig;
