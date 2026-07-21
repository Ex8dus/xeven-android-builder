// Programmatic Bubblewrap build — bypasses the CLI's interactive prompts entirely
// (regenerate/version/JDK), which don't work in CI. Reads twa-manifest.json,
// generates the Android project, and builds a signed APK + AAB with Gradle.
import fs from "node:fs";
import bubblewrap from "@bubblewrap/core";

const { TwaManifest, TwaGenerator, Config, JdkHelper, AndroidSdkTools, GradleWrapper, ConsoleLog } = bubblewrap;
const cwd = process.cwd();
const log = new ConsoleLog("xeven");

const twaManifest = await TwaManifest.fromFile("twa-manifest.json");

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
