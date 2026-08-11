#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set([".git", "node_modules", "coverage"]);
const forbidden = [
  { pattern: /\/home\/mrexamples(?:\/|$)/u, label: "developer-specific Linux home" },
  { pattern: /\/Users\/[A-Za-z0-9._-]+(?:\/|$)/u, label: "developer-specific macOS home" },
  { pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/u, label: "developer-specific Windows home" },
  { pattern: /(?:^|\/)auth\.json$/u, label: "credential file" },
];

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(full));
    else if (entry.isFile()) output.push(full);
  }
  return output;
}

const failures = [];
for (const file of await files(root)) {
  const relative = path.relative(root, file);
  if (forbidden[3].pattern.test(relative)) failures.push(`${relative}: ${forbidden[3].label}`);
  if (/\.(png|jpe?g|gif|webp|ico)$/iu.test(relative)) continue;
  const content = await readFile(file, "utf8");
  for (const rule of forbidden.slice(0, 3)) {
    if (rule.pattern.test(content)) failures.push(`${relative}: ${rule.label}`);
  }
}

if (failures.length) {
  process.stderr.write(`Portability check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Portability check passed.\n");
}
