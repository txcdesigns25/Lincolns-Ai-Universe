/**
 * Action catalog: every action an agent can take is classified into one of
 * three permission levels. This table is code, reviewed and tested; agents
 * cannot modify it.
 *
 * Level 1: fully automated (internal only, no external effect, no non-AI spend)
 * Level 2: allowed only if the owner pre-authorized it for that agent (agent_permissions)
 * Level 3: always requires an individual human approval
 */
export type PermissionLevel = 1 | 2 | 3;

export interface ActionSpec {
  level: PermissionLevel;
  external: boolean; // touches the outside world (requires live_mode)
  description: string;
}

export const ACTIONS: Record<string, ActionSpec> = {
  // Level 1
  "research.public": { level: 1, external: false, description: "Public market research and internal analysis" },
  "draft.create": { level: 1, external: false, description: "Generate drafts (listings, proposals, outreach) for review" },
  "memory.write": { level: 1, external: false, description: "Record observations, hypotheses, strategies" },
  "report.financial": { level: 1, external: false, description: "Read own financial reports" },
  "task.schedule_internal": { level: 1, external: false, description: "Schedule internal follow-up tasks" },
  "message.agent": { level: 1, external: false, description: "Send structured messages to other agents" },
  "owner.notify": { level: 1, external: false, description: "Tell the owner you are blocked on something only they can provide (rate-limited)" },
  "experiment.propose": { level: 1, external: false, description: "Propose an experiment (does not run it)" },
  "ai.inference": { level: 1, external: false, description: "Use the Claude API within the AI budget" },

  // Level 2
  "content.publish_approved": { level: 2, external: true, description: "Publish content that was already approved" },
  "website.update_owned": { level: 2, external: true, description: "Update websites we own" },
  "customer.routine_request": { level: 2, external: true, description: "Process routine authorized customer requests" },
  "workflow.run_preapproved": { level: 2, external: true, description: "Run a preapproved workflow" },
  "experiment.run_low_risk": { level: 2, external: false, description: "Run a low-risk, no-spend experiment" },
  "store.publish_owned": { level: 2, external: true, description: "Brand the owner's designated store and list/update/archive digital products on it (Apex only; store guard enforced)" },
  "strategy.self_update": { level: 2, external: false, description: "Activate a new version of own strategy prompt / playbook / cadence (reversible)" },

  // Level 3
  "purchase.new": { level: 3, external: true, description: "New purchase or subscription" },
  "budget.change": { level: 3, external: false, description: "Change spending limits" },
  "ads.launch": { level: 3, external: true, description: "Launch paid advertising" },
  "contract.enter": { level: 3, external: true, description: "Enter a customer contract" },
  "refund.significant": { level: 3, external: true, description: "Issue a significant refund" },
  "data.access_sensitive": { level: 3, external: false, description: "Access new sensitive data / cross-client data" },
  "permissions.change": { level: 3, external: false, description: "Change core agent permissions" },
  "deploy.production": { level: 3, external: true, description: "Deploy untested production code" },
  "listing.publish": { level: 3, external: true, description: "Publish a product listing to a live store" },
  "outreach.send": { level: 3, external: true, description: "Send outreach to a real person or business" },
  "task.assign": { level: 1, external: false, description: "CEO assigns an internal task to a business agent" },
};

export function getAction(action: string): ActionSpec {
  const spec = ACTIONS[action];
  // Fail safe: unknown actions are treated as the most restrictive level.
  return spec ?? { level: 3, external: true, description: `Unknown action ${action}` };
}
