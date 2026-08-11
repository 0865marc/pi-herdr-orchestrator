export const WORKFLOW_ENV_KEYS = [
  "PI_HERDR_ORCHESTRATOR_RUN_ID",
  "PI_HERDR_ORCHESTRATOR_ROLE",
  "PI_HERDR_ORCHESTRATOR_REPO_ROOT",
  "PI_HERDR_ORCHESTRATOR_ROLE_ROOT",
  "PI_HERDR_ORCHESTRATOR_PACKAGE_ROOT",
  "PI_HERDR_ORCHESTRATOR_MAX_INSPECTOR_PANES",
];

export function snapshotWorkflowEnvironment(env = process.env) {
  return Object.fromEntries(WORKFLOW_ENV_KEYS.map((key) => [key, env[key] ?? null]));
}

export function applyAdoptedEnvironment(state, config, env = process.env) {
  env.PI_HERDR_ORCHESTRATOR_RUN_ID = state.id;
  env.PI_HERDR_ORCHESTRATOR_ROLE = "orchestrator";
  env.PI_HERDR_ORCHESTRATOR_REPO_ROOT = state.repository.root;
  env.PI_HERDR_ORCHESTRATOR_ROLE_ROOT = state.repository.root;
  env.PI_HERDR_ORCHESTRATOR_PACKAGE_ROOT = state.packageRoot;
  env.PI_HERDR_ORCHESTRATOR_MAX_INSPECTOR_PANES = String(config.policy?.maxInspectorPanesPerRole ?? 3);
}

export function restoreWorkflowEnvironment(snapshot, env = process.env) {
  for (const key of WORKFLOW_ENV_KEYS) {
    const value = snapshot?.[key];
    if (typeof value === "string") env[key] = value;
    else delete env[key];
  }
}

export function modelReference(model) {
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return null;
  return { provider: model.provider, id: model.id };
}
