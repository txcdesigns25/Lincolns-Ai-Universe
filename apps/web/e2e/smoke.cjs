// Dashboard smoke test: pages load and the live-mode buttons work without an
// "Application error". Run against a running dashboard:
//   BASE_URL=http://localhost:3000 OWNER_PASSWORD=... node apps/web/e2e/smoke.cjs
// It toggles live mode and puts it back the way it was.
const { chromium } = require("playwright");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  p.on("dialog", (d) => d.accept());
  let failed = false;
  const check = async (label) => {
    const bad = (await p.content()).includes("Application error");
    failed ||= bad;
    console.log(label, bad ? "APP ERROR" : "ok");
  };
  const toggle = async (a, bText) => {
    const first = (await p.isVisible(`text=${a}`)) ? a : bText;
    const second = first === a ? bText : a;
    await p.click(`text=${first}`); await p.waitForTimeout(1500); await check(`  ${first}:`);
    await p.click(`text=${second}`); await p.waitForTimeout(1500); await check(`  ${second}:`);
  };

  await p.goto(`${BASE}/login`);
  await p.fill("input[name=password]", process.env.OWNER_PASSWORD ?? "");
  await p.click("button");
  await p.waitForURL((u) => !u.pathname.startsWith("/login"));

  for (const path of ["/", "/agents", "/agents/web_agency", "/agents/ceo", "/budgets", "/settings", "/tasks", "/expenses", "/approvals"]) {
    await p.goto(BASE + path); await check(path);
  }
  console.log("agent page live toggle");
  await p.goto(`${BASE}/agents/web_agency`); await toggle("Enable live mode", "Switch to sandbox");
  console.log("all agents live toggle");
  await p.goto(`${BASE}/agents`); await toggle("Live all", "Sandbox all");
  await b.close();
  if (failed) process.exit(1);
})();
