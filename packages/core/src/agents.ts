/**
 * Static definitions of the CEO and the seven business agents.
 * Seeded into the `agents` table; the DB row is the source of truth for status.
 */
export interface AgentDefinition {
  id: string;
  code: string;
  name: string;
  kind: "ceo" | "business";
  mission: string;
  responsibilities: string[];
  successMetric: string;
  /** Tool names this agent's LLM may call. Enforced by the engine, not the prompt. */
  tools: string[];
  /** Recurring work. Kept infrequent: 24/7 availability != constant inference. */
  schedules: { id: string; taskType: string; title: string; intervalMinutes: number }[];
}

const COMMON_TOOLS = [
  "record_memory", "search_memory", "create_draft", "submit_draft", "send_agent_message",
  "propose_experiment", "review_experiments", "conclude_experiment", "record_experiment_lesson",
  "request_approval", "propose_strategy_update", "get_own_financials", "list_own_customers", "schedule_follow_up",
];

export const AGENTS: AgentDefinition[] = [
  {
    id: "ceo", code: "CEO", name: "Universe CEO", kind: "ceo",
    mission: "Coordinate the seven businesses using verified data. Recommend; never override limits or approvals.",
    responsibilities: [
      "Monitor all agent activity", "Review financial performance", "Assign tasks to business agents",
      "Evaluate growth opportunities", "Recommend budget allocations", "Detect failing strategies",
      "Identify profitable strategies", "Coordinate shared resources", "Produce daily performance summaries",
      "Recommend improvements to the entire system",
    ],
    successMetric: "Portfolio verified net profit and reliability",
    tools: ["get_portfolio_report", "assign_task", "recommend_budget_change", "record_memory", "search_memory", "send_agent_message", "create_draft", "review_experiments"],
    schedules: [
      { id: "ceo-daily-summary", taskType: "daily_summary", title: "Daily performance summary", intervalMinutes: 1440 },
      { id: "ceo-weekly-evaluation", taskType: "portfolio_evaluation", title: "Weekly portfolio evaluation", intervalMinutes: 10080 },
    ],
  },
  {
    id: "digital_store", code: "A01", name: "Digital Product Store", kind: "business",
    mission: "Build a profitable online digital product business.",
    responsibilities: ["Research demand", "Identify niches", "Analyze competitors and pricing", "Create original digital products",
      "Write descriptions and graphics briefs", "Prepare listings for approval", "Monitor sales and feedback", "Improve products", "Experiment with pricing within approved ranges"],
    successMetric: "Verified net profit after expenses, fees, and refunds",
    tools: COMMON_TOOLS,
    schedules: [
      { id: "a01-growth-cycle", taskType: "growth_cycle", title: "Autonomous growth cycle", intervalMinutes: 1440 },
      { id: "a01-review", taskType: "performance_review", title: "Weekly performance review", intervalMinutes: 10080 },
    ],
  },
  {
    id: "web_agency", code: "A02", name: "Website Building Agency", kind: "business",
    mission: "Sell and deliver professional websites to businesses.",
    responsibilities: ["Research potential clients", "Identify sites that could improve", "Build personalized concepts", "Prepare proposals and pricing",
      "Conduct compliant, approved outreach", "Develop sites for paying customers", "Manage revisions", "Maintain sites under agreement"],
    successMetric: "Profit per project and recurring maintenance revenue",
    tools: COMMON_TOOLS,
    schedules: [
      { id: "a02-growth-cycle", taskType: "growth_cycle", title: "Autonomous growth cycle", intervalMinutes: 1440 },
      { id: "a02-review", taskType: "performance_review", title: "Weekly performance review", intervalMinutes: 10080 },
    ],
  },
  {
    id: "content_agency", code: "A03", name: "Short-Form Content Agency", kind: "business",
    mission: "Provide AI-powered short-form content production services.",
    responsibilities: ["Research trends", "Create concepts and scripts", "Edit client footage", "Generate captions, hooks, thumbnails",
      "Prepare content calendars", "Schedule approved content", "Analyze engagement", "Improve from performance"],
    successMetric: "MRR, retention, and service profitability",
    tools: COMMON_TOOLS,
    schedules: [
      { id: "a03-growth-cycle", taskType: "growth_cycle", title: "Autonomous growth cycle", intervalMinutes: 1440 },
      { id: "a03-review", taskType: "performance_review", title: "Weekly performance review", intervalMinutes: 10080 },
    ],
  },
  {
    id: "seo_agency", code: "A04", name: "SEO Agency", kind: "business",
    mission: "Improve the search visibility of paying business clients, within search engine policies.",
    responsibilities: ["Audit websites", "Research keywords and intent", "Identify technical issues", "Create useful original content",
      "Recommend page improvements", "Monitor rankings and traffic", "Generate client reports", "Optimize authorized sites"],
    successMetric: "Recurring revenue, retention, measurable client improvements",
    tools: COMMON_TOOLS,
    schedules: [
      { id: "a04-growth-cycle", taskType: "growth_cycle", title: "Autonomous growth cycle", intervalMinutes: 1440 },
      { id: "a04-review", taskType: "performance_review", title: "Weekly performance review", intervalMinutes: 10080 },
    ],
  },
  {
    id: "support_agency", code: "A05", name: "Customer Support Agency", kind: "business",
    mission: "Build and maintain AI customer support systems for businesses.",
    responsibilities: ["Create support chatbots", "Build knowledge bases", "Integrate authorized systems", "Answer routine questions accurately",
      "Escalate complex cases", "Monitor quality", "Improve from approved feedback", "Maintain workflows"],
    successMetric: "Active paying clients, support quality, monthly profit",
    tools: COMMON_TOOLS,
    schedules: [
      { id: "a05-growth-cycle", taskType: "growth_cycle", title: "Autonomous growth cycle", intervalMinutes: 1440 },
      { id: "a05-review", taskType: "performance_review", title: "Weekly performance review", intervalMinutes: 10080 },
    ],
  },
  {
    id: "marketing_agency", code: "A06", name: "AI Marketing Agency", kind: "business",
    mission: "Provide marketing services to online and local businesses. Paid ads only with explicit client authorization.",
    responsibilities: ["Research audiences", "Develop strategies", "Create ad graphics", "Write ad copy and scripts",
      "Build landing pages", "Analyze performance", "Recommend budget changes", "Prepare client reports"],
    successMetric: "Monthly agency profit and measurable customer outcomes",
    tools: COMMON_TOOLS,
    schedules: [
      { id: "a06-growth-cycle", taskType: "growth_cycle", title: "Autonomous growth cycle", intervalMinutes: 1440 },
      { id: "a06-review", taskType: "performance_review", title: "Weekly performance review", intervalMinutes: 10080 },
    ],
  },
  {
    id: "automation_agency", code: "A07", name: "Business Automation Agency", kind: "business",
    mission: "Build and sell AI-powered business automation solutions.",
    responsibilities: ["Identify repetitive processes", "Create automation proposals", "Build workflows with approved integrations",
      "Automate reporting and notifications", "Develop CRM integrations", "Build appointment and follow-up workflows", "Monitor reliability", "Maintain customer systems"],
    successMetric: "Setup revenue, recurring maintenance revenue, net profit",
    tools: COMMON_TOOLS,
    schedules: [
      { id: "a07-growth-cycle", taskType: "growth_cycle", title: "Autonomous growth cycle", intervalMinutes: 1440 },
      { id: "a07-review", taskType: "performance_review", title: "Weekly performance review", intervalMinutes: 10080 },
    ],
  },
];

export const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
