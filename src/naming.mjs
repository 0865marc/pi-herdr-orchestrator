import { createHash, randomBytes } from "node:crypto";

const ROLE_CODES = {
  orchestrator: "orch",
  scout: "scout",
  builder: "build",
  reviewer: "review",
};

export function slugify(value, fallback = "project") {
  const slug = String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || fallback;
}

export function shortHash(value, length = 6) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

export function createRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function workspaceLabel(project, role, separator = " · ") {
  return `${project}${separator}${role}`;
}

export function agentName(project, role, runId) {
  const code = ROLE_CODES[role] ?? slugify(role).slice(0, 6);
  const suffix = shortHash(runId, 5);
  const maxProject = Math.max(1, 32 - code.length - suffix.length - 2);
  const prefix = slugify(project).slice(0, maxProject).replace(/-+$/g, "") || "p";
  const name = `${prefix}-${code}-${suffix}`;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
    throw new Error(`Generated invalid Herdr agent name: ${name}`);
  }
  return name;
}

export function writerAgentName(project, runId, laneId) {
  const suffix = shortHash(`${runId}:${laneId}`, 7);
  const maxProject = Math.max(1, 32 - suffix.length - 4);
  const prefix = slugify(project).slice(0, maxProject).replace(/-+$/g, "") || "p";
  return `${prefix}-w-${suffix}`;
}

export function defaultTaskBranch(task, runId) {
  const taskSlug = slugify(task, "task").slice(0, 36).replace(/-+$/g, "") || "task";
  return `workflow/${taskSlug}-${shortHash(runId, 6)}`;
}
