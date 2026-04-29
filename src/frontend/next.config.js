/** @type {import('next').NextConfig} */
const nextConfig = {
  // Default proxy timeout for rewrites is ~30s, but /api/patient/ingest
  // takes 30-45s (Cerebral scrape subprocess + Claude Sonnet summarization)
  // and chat turns occasionally near 30s under load. Bump to 5 minutes so
  // long upstream calls aren't killed mid-flight when accessed via tunnel.
  experimental: {
    proxyTimeout: 300_000,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:8000/api/:path*',
      },
      {
        source: '/ws/:path*',
        destination: 'http://localhost:8000/ws/:path*',
      },
    ];
  },
};

module.exports = nextConfig;
