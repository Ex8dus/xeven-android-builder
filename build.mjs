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
import { execFileSync } from "node:child_process";
import bubblewrap from "@bubblewrap/core";
import Jimp from "jimp";

const { TwaManifest, TwaGenerator, ConsoleLog } = bubblewrap;
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

// 2) Build with Gradle directly (not @bubblewrap/core's GradleWrapper, which can
//    hang on the daemon/rich-console in CI). --no-daemon + --console=plain keep it
//    non-interactive with streaming logs; both tasks in one invocation share config.
//    Signing config in the generated build.gradle reads the keystore path from the
//    manifest + passwords from BUBBLEWRAP_*_PASSWORD env.
const sdkDir = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
fs.writeFileSync("local.properties", `sdk.dir=${sdkDir}\n`);
try { fs.chmodSync("gradlew", 0o755); } catch { /* ignore */ }
// Build the signed APK (direct install) + AAB (Google Play) in one invocation.
const tasks = (process.env.BUILD_TASKS || "assembleRelease bundleRelease").split(" ");
console.log("Running Gradle: " + tasks.join(" ") + " …");
execFileSync(
  "./gradlew",
  [...tasks, "--no-daemon", "--console=plain", "--stacktrace"],
  {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ANDROID_HOME: sdkDir, ANDROID_SDK_ROOT: sdkDir, GRADLE_OPTS: "-Dorg.gradle.jvmargs=-Xmx4g" },
  },
);

// 3) SIGN the artifacts. Gradle alone produces an UNSIGNED apk here (the Bubblewrap
//    CLI normally signs afterwards), and Android refuses to install unsigned APKs
//    ("App not installed"). So we zipalign + apksigner ourselves, then verify.
function findBuildTool(name) {
  const base = `${sdkDir}/build-tools`;
  const versions = fs.readdirSync(base).sort().reverse();
  for (const v of versions) {
    const p = `${base}/${v}/${name}`;
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`${name} not found under ${base}`);
}

const keystore = `${cwd}/android.keystore`;
const storePass = process.env.BUBBLEWRAP_KEYSTORE_PASSWORD || "";
const keyPass = process.env.BUBBLEWRAP_KEY_PASSWORD || storePass;
const alias = "xeven";

const apkIn = ["app/build/outputs/apk/release/app-release-unsigned.apk",
               "app/build/outputs/apk/release/app-release.apk"].find((p) => fs.existsSync(p));
if (!apkIn) throw new Error("Gradle produced no APK under app/build/outputs/apk/release/");

console.log("Signing APK…");
execFileSync(findBuildTool("zipalign"), ["-p", "-f", "4", apkIn, "app-release-aligned.apk"], { cwd, stdio: "inherit" });
execFileSync(findBuildTool("apksigner"), [
  "sign", "--ks", keystore, "--ks-pass", `pass:${storePass}`,
  "--ks-key-alias", alias, "--key-pass", `pass:${keyPass}`,
  "--out", "app-release-signed.apk", "app-release-aligned.apk",
], { cwd, stdio: "inherit" });
// Hard gate: never publish an APK that isn't really signed.
execFileSync(findBuildTool("apksigner"), ["verify", "--print-certs", "app-release-signed.apk"], { cwd, stdio: "inherit" });

// The AAB for Play Store is signed with jarsigner (JAR-style signing).
const aab = "app/build/outputs/bundle/release/app-release.aab";
if (fs.existsSync(aab)) {
  console.log("Signing AAB…");
  execFileSync(`${process.env.JAVA_HOME}/bin/jarsigner`, [
    "-keystore", keystore, "-storepass", storePass, "-keypass", keyPass,
    "-signedjar", "app-release-bundle.aab", aab, alias,
  ], { cwd, stdio: "inherit" });
}

console.log("BUILD OK -> signed apk + " + (fs.existsSync("app-release-bundle.aab") ? "signed aab" : "no aab"));
server.close();
