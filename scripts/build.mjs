import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "extension");
const output = join(root, "dist", "youtube-decisions-thumbnail-filters");
const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Manifest V3 required.");
if (JSON.stringify(manifest.permissions) !== '["storage"]') throw new Error("Unexpected permissions.");
if (JSON.stringify(manifest.host_permissions) !== '["https://api.openai.com/*","https://*.ytimg.com/*","https://img.youtube.com/*"]') throw new Error("Unexpected API access.");
const resources = [manifest.action.default_popup, manifest.background.service_worker, "decisions.js", "evaluation-cache.js", "work-sharing.js", "spending.js", "analytics.js", "patterns.js", "pattern-ui.js", ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon), ...manifest.content_scripts.flatMap(({ js, css }) => [...js, ...css])];
for (const resource of resources) {
  if (resource.includes("..") || !(await stat(join(source, resource))).isFile()) throw new Error(`Invalid resource: ${resource}`);
}
for (const file of await readdir(source)) {
  if (file.endsWith(".js")) new Script(await readFile(join(source, file), "utf8"), { filename: file });
}
await mkdir(dirname(output), { recursive: true });
await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
console.log(`Build succeeded: ${output}\nLoad this folder as an unpacked Chrome extension.`);
