import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hostinger managed Node hosting: emit a minimal self-contained server.
  // Do not remove — the deployed footprint depends on it (CLAUDE.md, spec §11).
  output: "standalone",
  // Photos are served from storage with signed URLs; disabling the built-in
  // optimizer also removes that self-hosted attack surface.
  images: { unoptimized: true },
};

export default nextConfig;
