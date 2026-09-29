import { build } from "esbuild";

await build({
  entryPoints: ["src/ui/pulse-globe.mjs"],
  outfile: "public/pulse-globe.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  treeShaking: true,
  legalComments: "none",
});

console.log("pulse-globe.js bundled locally from npm dependencies.");
