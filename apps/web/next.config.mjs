/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TS source, not builds — Next compiles them in place.
  transpilePackages: [
    '@bizsim/engine',
    '@bizsim/llm',
    '@bizsim/money',
    '@bizsim/schemas',
    '@bizsim/seeds',
    '@bizsim/sim-cli',
  ],
  // The workspace packages import each other nodenext-style ('./tick.js' for
  // tick.ts); teach webpack the same resolution tsc and vitest already use.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};

export default nextConfig;
