// Programmatic Bubblewrap build — bypasses the CLI's interactive prompts entirely
// (regenerate/version/JDK), which don't work in CI. Reads twa-manifest.json,
// generates the Android project, and builds a signed APK + AAB with Gradle.
//
// Robustness: if the app's icon or web manifest URL isn't reachable/valid, we fall
// back to minimal placeholders served from a tiny localhost server, so a missing
// PWA asset never fails the whole build. Real published apps ship both, so the
// fallbacks don't trigger for them.
import fs from "node:fs";
import http from "node:http";
import bubblewrap from "@bubblewrap/core";
import Jimp from "jimp";

const { TwaManifest, TwaGenerator, Config, JdkHelper, AndroidSdkTools, GradleWrapper, ConsoleLog } = bubblewrap;
const cwd = process.cwd();
const log = new ConsoleLog("xeven");

const twaManifest = await TwaManifest.fromFile("twa-manifest.json");

// Built with Jimp (bubblewrap's own image lib) so its pngjs always parses it.
const FALLBACK_PNG = await new Jimp(512, 512, 0x7c6cffff).getBufferAsync(Jimp.MIME_PNG);
const FALLBACK_MANIFEST = JSON.stringify({
  name: twaManifest.name || "App",
  short_name: (twaManifest.name || "App").slice(0, 12),
  start_url: twaManifest.startUrl || "/",
  scope: "/",
  display: "standalone",
  theme_color: twaManifest.themeColor || "#7c6cff",
  background_color: "#ffffff",
  icons: [{ src: "icon.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }],
});

// Serves a fallback manifest (JSON) or icon (PNG) depending on the path.
const server = http.createServer((req, res) => {
  if ((req.url || "").includes("manifest")) {
    const body = Buffer.from(FALLBACK_MANIFEST);
    res.writeHead(200, { "Content-Type": "application/manifest+json", "Content-Length": body.length });
    res.end(body);
  } else {
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": FALLBACK_PNG.length });
    res.end(FALLBACK_PNG);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function ok(url, kind) {
  try {
    const r = await fetch(url, { method: "GET" });
    if (!r.ok) return false;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (kind === "image") return ct.startsWith("image/");
    const txt = await r.text();
    JSON.parse(txt); // manifest must be valid JSON
    return true;
  } catch { return false; }
}

if (!(await ok(twaManifest.iconUrl, "image"))) {
  console.log(`icon "${twaManifest.iconUrl}" invalid → fallback`);
  twaManifest.iconUrl = `${origin}/icon.png`;
}
if (twaManifest.webManifestUrl && !(await ok(twaManifest.webManifestUrl, "json"))) {
  console.log(`web manifest "${twaManifest.webManifestUrl}" invalid → fallback`);
  twaManifest.webManifestUrl = new URL(`${origin}/manifest.webmanifest`);
}

// 1) Generate the Android project from the manifest (no prompts).
await new TwaGenerator().createTwaProject(cwd, twaManifest, log);

// 2) Build with Gradle. Signing config in the generated build.gradle reads the
//    keystore path from the manifest + passwords from BUBBLEWRAP_*_PASSWORD env.
const config = new Config(process.env.JAVA_HOME, process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT);
const jdkHelper = new JdkHelper(process, config);
const androidSdkTools = await AndroidSdkTools.create(process, config, jdkHelper, log);
const gradle = new GradleWrapper(process, androidSdkTools, cwd);

await gradle.assembleRelease();
await gradle.bundleRelease();

// 3) Copy artifacts to predictable names at the repo root for the release step.
const apkCandidates = [
  "app/build/outputs/apk/release/app-release.apk",
  "app/build/outputs/apk/release/app-release-signed.apk",
  "app/build/outputs/apk/release/app-release-unsigned.apk",
];
const apk = apkCandidates.find((p) => fs.existsSync(p));
const aab = "app/build/outputs/bundle/release/app-release.aab";
if (!apk) throw new Error("No APK produced at " + apkCandidates.join(", "));
fs.copyFileSync(apk, "app-release-signed.apk");
if (fs.existsSync(aab)) fs.copyFileSync(aab, "app-release-bundle.aab");
console.log("BUILD OK -> apk:" + apk + " aab:" + (fs.existsSync(aab) ? aab : "none"));
server.close();
