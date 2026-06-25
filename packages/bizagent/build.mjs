// Build the `biz` bin + the library entry into dist/ (single bundled files each).
import { chmodSync, existsSync } from "node:fs";

// Deploy hosts install this package as a file: dep with dist/ shipped pre-built and no
// devDependencies — yet npm still runs `prepare` for file: deps even under --ignore-scripts.
// No esbuild + a complete dist/ means "pre-built, nothing to do"; missing dist too is a
// genuine broken install and should fail loudly.
let build;
try {
  ({ build } = await import("esbuild"));
} catch {
  const dist = ["dist/biz.mjs", "dist/index.mjs", "dist/client.mjs"];
  if (dist.every((f) => existsSync(new URL(f, import.meta.url)))) {
    console.log("esbuild unavailable — keeping pre-built dist/ (deploy host)");
    process.exit(0);
  }
  console.error("esbuild missing and dist/ incomplete — run npm install (with devDependencies) first");
  process.exit(1);
}

const common = { bundle: true, platform: "node", format: "esm", target: "node20" };

await build({
  ...common,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/biz.mjs",
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("dist/biz.mjs", 0o755);

await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/index.mjs" });

// The headless client is browser-safe (its only imports from the core are type-only, so they
// erase). Build it as a separate, node-free entry so a frontend can import `bizagent/client`
// without dragging fs/http into the browser bundle.
await build({
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2020",
  entryPoints: ["src/client.ts"],
  outfile: "dist/client.mjs",
});

console.log("built dist/biz.mjs (bin) + dist/index.mjs (lib) + dist/client.mjs (browser)");
