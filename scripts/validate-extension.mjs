import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const firefoxManifest = JSON.parse(
  await readFile(new URL("../extension/manifest.firefox.json", import.meta.url), "utf8"),
);
const source = await readFile(new URL("../localefence.user.js", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const userscriptName = source.match(/^\/\/ @name\s+(.+)$/m)?.[1]?.trim();
const userscriptNamespace = source.match(/^\/\/ @namespace\s+(\S+)$/m)?.[1];
const userscriptVersion = source.match(/^\/\/ @version\s+(\S+)$/m)?.[1];
const runtimeVersion = source.match(/const runtimeVersion = "([^"]+)"/)?.[1];

assert.equal(manifest.manifest_version, 3);
assert.equal(userscriptName, "LocaleFence for X", "userscript @name is part of its update identity");
assert.equal(
  userscriptNamespace,
  "https://github.com/ssupt/LocaleFence",
  "userscript @namespace is part of its update identity",
);
assert.equal(manifest.name, "LocaleFence - Country Filter for X");
assert.equal(manifest.version, userscriptVersion, "manifest and userscript versions must match");
assert.equal(firefoxManifest.version, userscriptVersion, "Firefox and userscript versions must match");
assert.equal(packageJson.version, userscriptVersion, "package and userscript versions must match");
assert.equal(runtimeVersion, userscriptVersion, "runtime marker and userscript versions must match");
assert.ok(manifest.name.length <= 45, "Chrome extension names are limited to 45 characters");
assert.ok(manifest.description.length <= 132, "Chrome extension descriptions are limited to 132 characters");
assert.deepEqual(manifest.content_scripts?.[0]?.matches, ["https://x.com/*"]);
assert.equal(manifest.permissions, undefined, "do not add extension permissions without a current need");
assert.deepEqual(firefoxManifest.content_scripts?.[0]?.matches, ["https://x.com/*"]);
assert.match(firefoxManifest.browser_specific_settings?.gecko?.id || "", /@/);
assert.ok(firefoxManifest.browser_specific_settings?.gecko_android?.strict_min_version);

for (const relativePath of Object.values(manifest.icons)) {
  await readFile(new URL(`../${relativePath}`, import.meta.url));
}

console.log(`Manifest V3 package metadata is valid (${manifest.version}, ${root})`);
