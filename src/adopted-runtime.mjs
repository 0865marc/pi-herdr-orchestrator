export const WORKFLOW_ENV_KEYS = [
  "HERDR_WORKFLOW_RUN_ID",
  "HERDR_WORKFLOW_ROLE",
  "HERDR_WORKFLOW_REPO_ROOT",
  "HERDR_WORKFLOW_ROLE_ROOT",
  "HERDR_WORKFLOW_PACKAGE_ROOT",
  "HERDR_WORKFLOW_MAX_INSPECTOR_PANES",
];

export function snapshotWorkflowEnvironment(env = process.env) {
  return Object.fromEntries(WORKFLOW_ENV_KEYS.map((key) => [key, env[key] ?? null]));
}

export function applyAdoptedEnvironment(state, config, env = process.env) {
  env.HERDR_WORKFLOW_RUN_ID = state.id;
  env.HERDR_WORKFLOW_ROLE = "orchestrator";
  env.HERDR_WORKFLOW_REPO_ROOT = state.repository.root;
  env.HERDR_WORKFLOW_ROLE_ROOT = state.repository.root;
  env.HERDR_WORKFLOW_PACKAGE_ROOT = state.packageRoot;
  env.HERDR_WORKFLOW_MAX_INSPECTOR_PANES = String(config.policy?.maxInspectorPanesPerRole ?? 3);
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
