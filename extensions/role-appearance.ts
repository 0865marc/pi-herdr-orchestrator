import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";

export const ROLE_APPEARANCE_KEY = "pi-herdr-orchestrator:role-appearance";

type WorkflowRole = "orchestrator" | "scout" | "builder" | "reviewer";

export interface RoleAppearance {
  icon: string;
  label: string;
  color: ThemeColor;
}

export const ROLE_APPEARANCES: Readonly<Record<WorkflowRole, RoleAppearance>> = {
  orchestrator: { icon: "[O]", label: "ORCHESTRATOR", color: "accent" },
  scout: { icon: "[S]", label: "SCOUT", color: "success" },
  builder: { icon: "[B]", label: "BUILDER", color: "warning" },
  reviewer: { icon: "[R]", label: "REVIEWER", color: "error" },
};

export function roleAppearanceFor(role: unknown): RoleAppearance | undefined {
  if (typeof role !== "string" || !Object.hasOwn(ROLE_APPEARANCES, role)) return undefined;
  return ROLE_APPEARANCES[role as WorkflowRole];
}

export function applyRoleAppearance(ctx: Pick<ExtensionContext, "hasUI" | "ui">): () => void {
  const appearance = roleAppearanceFor(process.env.PI_HERDR_ORCHESTRATOR_ROLE);
  if (!appearance || !ctx.hasUI) return () => {};

  const label = ctx.ui.theme.fg(appearance.color, `${appearance.icon} ${appearance.label}`);
  ctx.ui.setWidget(ROLE_APPEARANCE_KEY, [label], { placement: "aboveEditor" });
  ctx.ui.setStatus(ROLE_APPEARANCE_KEY, label);

  return () => {
    ctx.ui.setWidget(ROLE_APPEARANCE_KEY, undefined, { placement: "aboveEditor" });
    ctx.ui.setStatus(ROLE_APPEARANCE_KEY, undefined);
  };
}

export default function roleAppearance(pi: ExtensionAPI) {
  let disposeAppearance = () => {};

  pi.on("session_start", (_event, ctx) => {
    disposeAppearance();
    disposeAppearance = applyRoleAppearance(ctx);
  });
  pi.on("session_shutdown", () => {
    disposeAppearance();
    disposeAppearance = () => {};
  });
}
