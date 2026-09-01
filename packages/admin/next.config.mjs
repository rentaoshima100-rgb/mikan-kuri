// Next.js 設定 (プレーンJS)。
// .ts ではなく .mjs にしているのは、Vercelの本番インストールが devDependencies を
// 省くと next.config.ts の読み込みに必要な typescript が無く「Cannot find module 'typescript'」で
// ビルドが落ちるため。JSのconfigなら typescript 無しで読める。型ヒントはJSDocで補う。
/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@nortiq/pipeline", "@nortiq/shared"],
  // 型/リントは別途 `npm run typecheck` / `npm run lint` (CI) で担保する。
  // Nextビルドはワークスペース越しの型検査で落ちやすいので、デプロイをブロックしない。
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  webpack: (config) => {
    // @nortiq/* はESM流儀 (.js拡張子import) のTSソースを直接exportしているため、
    // .js → .ts の解決を許可する
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
