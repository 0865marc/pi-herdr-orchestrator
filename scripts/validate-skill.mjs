#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const target = path.resolve(process.argv[2] || "");
if (!target) throw new Error("Usage: validate-skill.mjs PATH");

const skillFile = path.join(target, "SKILL.md");
const content = await readFile(skillFile, "utf8");
const match = content.match(/^---\n([\s\S]*?)\n---\n/u);
if (!match) throw new Error("SKILL.md must start with YAML frontmatter.");
const lines = match[1].split("\n").filter(Boolean);
const keys = lines.map((line) => line.match(/^([a-zA-Z0-9_-]+):/u)?.[1]).filter(Boolean);
if (keys.length !== 2 || !keys.includes("name") || !keys.includes("description")) {
  throw new Error("SKILL.md frontmatter must contain exactly name and description.");
}
const name = lines.find((line) => line.startsWith("name:"))?.slice(5).trim();
const description = lines.find((line) => line.startsWith("description:"))?.slice(12).trim();
if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) throw new Error(`Invalid skill name: ${name}`);
if (path.basename(target) !== name) throw new Error("Skill folder must match skill name.");
if (!description || description.length > 1024) throw new Error("Skill description must contain 1-1024 characters.");
if (/\bTODO\b/u.test(content)) throw new Error("SKILL.md still contains TODO markers.");
await stat(path.join(target, "agents", "openai.yaml"));
process.stdout.write(`Skill '${name}' passed repository validation.\n`);
