// Programmatic Bubblewrap build — bypasses the CLI's interactive prompts entirely
// (regenerate/version/JDK), which don't work in CI. Reads twa-manifest.json,
// generates the Android project, and builds a signed APK + AAB with Gradle.
//
// Robustness: if the app's icon URL isn't a real image (missing/misconfigured),
// we fall back to a bundled placeholder served from a tiny localhost server, so a
// bad icon never fails the whole build.
import fs from "node:fs";
import http from "node:http";
import bubblewrap from "@bubblewrap/core";
import Jimp from "jimp";

const { TwaManifest, TwaGenerator, Config, JdkHelper, AndroidSdkTools, GradleWrapper, ConsoleLog } = bubblewrap;
const cwd = process.cwd();
const log = new ConsoleLog("xeven");

// A 512×512 solid-brand PNG used only when the real icon can't be fetched. Built
// with Jimp (bubblewrap's own image lib) so pngjs is guaranteed to parse it.
const FALLBACK_PNG = await new Jimp(512, 512, 0x7c6cffff).getBufferAsync(Jimp.MIME_PNG);

// Tiny localhost server that hands out the fallback PNG when needed.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "image/png", "Content-Length": FALLBACK_PNG.length });
  res.end(FALLBACK_PNG);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fallbackUrl = `http://127.0.0.1:${server.address().port}/icon.png`;

async function isRealImage(url) {
  try {
    const r = await fetch(url, { method: "GET" });
    return r.ok && (r.headers.get("content-type") || "").toLowerCase().startsWith("image/");
  } catch {
    return false;
  }
}

const twaManifest = await TwaManifest.fromFile("twa-manifest.json");
if (!(await isRealImage(twaManifest.iconUrl))) {
  console.log(`icon "${twaManifest.iconUrl}" not a valid image → using fallback`);
  twaManifest.iconUrl = fallbackUrl;
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
