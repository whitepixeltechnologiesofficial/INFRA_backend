const path = require("path");

const apiBaseUrl = process.env.API_BASE_URL || "auto://lan";

module.exports = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  reactStrictMode: true,
  transpilePackages: ["@wpt/shared", "@wpt/api-client", "@wpt/crypto"],
  env: {
    NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
    NEXT_PUBLIC_LINKING_SERVER_HOST: process.env.NEXT_PUBLIC_LINKING_SERVER_HOST || "",
    NEXT_PUBLIC_LINKING_SERVER_PORT: process.env.LINKING_SERVER_PORT || "8787"
  }
};
