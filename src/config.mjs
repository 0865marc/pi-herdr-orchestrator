import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function loadConfig(root = PACKAGE_ROOT, env = process.env) {
  const file = path.join(root, "config", "workflow.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  if (config.schemaVersion !== 1 || !config.roles?.orchestrator) {
    throw new Error(`Unsupported workflow config: ${file}`);
  }
  if (env.PI_HERDR_ORCHESTRATOR_PROVIDER) config.provider = env.PI_HERDR_ORCHESTRATOR_PROVIDER;
  if (env.PI_HERDR_ORCHESTRATOR_LAUNCH_MODE) config.orchestratorLaunchMode = env.PI_HERDR_ORCHESTRATOR_LAUNCH_MODE;
  resolveLaunchMode(config);
  for (const role of Object.keys(config.roles)) {
    const key = `PI_HERDR_ORCHESTRATOR_${role.toUpperCase()}_MODEL`;
    if (env[key]) config.roles[role].model = env[key];
  }
  return config;
}

export function resolveLaunchMode(config, explicit) {
  const mode = explicit || config.orchestratorLaunchMode || "isolated";
  if (!['isolated', 'adopt-current'].includes(mode)) {
    throw new Error(`Unsupported Orchestrator launch mode: ${mode}`);
  }
  return mode;
}

export function packageResources(root = PACKAGE_ROOT) {
  return {
    root,
    workflowExtension: path.join(root, "extensions", "pi-herdr-orchestrator.ts"),
    guardExtension: path.join(root, "extensions", "role-guard.ts"),
    autoInspectorsExtension: path.join(root, "extensions", "auto-inspectors.ts"),
    askUserQuestionExtension: path.join(root, "extensions", "ask-user-question.ts"),
    askUserQuestionPackage: path.join(root, "node_modules", "@juicesharp", "rpiv-ask-user-question", "index.ts"),
    subagentsExtension: path.join(root, "node_modules", "pi-subagents", "index.ts"),
    subagentsSkill: path.join(root, "node_modules", "pi-subagents", "skills", "pi-subagents"),
  };
}

export function assertPackageReady(root = PACKAGE_ROOT) {
  const resources = packageResources(root);
  const missing = Object.entries(resources)
    .filter(([key, value]) => key !== "root" && !existsSync(value))
    .map(([, value]) => value);
  if (missing.length) {
    throw new Error(`Package dependencies are not installed. Run npm install in ${root}. Missing:\n${missing.join("\n")}`);
  }
  return resources;
}

export function roleArgs({ role, agentName, root = PACKAGE_ROOT, config, sessionDir }) {
  const roleConfig = config.roles[role];
  if (!roleConfig) throw new Error(`Unknown role: ${role}`);
  const resources = assertPackageReady(root);
  const args = [
    "--provider", config.provider,
    "--model", roleConfig.model,
    "--thinking", roleConfig.thinking,
    "--tools", roleConfig.tools.join(","),
    "--no-extensions",
    "--extension", resources.guardExtension,
  ];
  if (role === "orchestrator") {
    args.push(
      "--extension", resources.workflowExtension,
      "--extension", resources.askUserQuestionExtension,
    );
  }
  args.push(
    "--extension", resources.subagentsExtension,
    "--extension", resources.autoInspectorsExtension,
    "--no-skills",
    "--skill", resources.subagentsSkill,
    "--no-prompt-templates",
    "--no-approve",
    "--append-system-prompt", path.join(root, "roles", `${role}.md`),
    "--name", agentName,
  );
  if (config.loadContextFiles === false) args.push("--no-context-files");
  if (sessionDir) args.push("--session-dir", sessionDir);
  return args;
}
