import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const firefoxManifest = JSON.parse(
  await readFile(new URL("../extension/manifest.firefox.json", import.meta.url), "utf8"),
);

const build = async (directory, buildManifest) => {
  const output = `${root}/dist/${directory}`;
  await rm(output, { force: true, recursive: true });
  await mkdir(`${output}/extension/icons`, { recursive: true });
  for (const file of ["LICENSE", "PRIVACY.md", "localefence.user.js"]) {
    await cp(`${root}/${file}`, `${output}/${file}`);
  }
  for (const icon of Object.values(buildManifest.icons)) {
    await cp(`${root}/${icon}`, `${output}/${icon}`);
  }
  await writeFile(`${output}/manifest.json`, `${JSON.stringify(buildManifest, null, 2)}\n`);
  return output;
};

const chromiumOutput = await build("localefence-chromium", manifest);
const firefoxOutput = await build("localefence-firefox", firefoxManifest);
console.log(`Built unpacked Chromium extension at ${chromiumOutput}`);
console.log(`Built unpacked Firefox/Android extension at ${firefoxOutput}`);
