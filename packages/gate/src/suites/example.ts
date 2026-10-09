import type { Task } from "../types.js";
import { defineOutputTask, parseCSV, round, sortedObject } from "./define.js";

/**
 * Example suite: 16 data/ops tasks from 2 minutes to 16 hours (two messy tasks ≥ 8h, so S1 is certifiable).
 *
 * IMPORTANT: `humanMinutes` values here are illustrative placeholders chosen
 * to span the range the horizon fit needs. They are NOT calibrated human
 * baselines. Before certifying any gate, replace them with timed baselines
 * from skilled humans (see docs/02-task-authoring.md).
 */

const num = (s: string | undefined): number => Number(s ?? "0");

// 1 — 2 min
const salesTotal = defineOutputTask({
  id: "sales-total",
  title: "Sum a sales column",
  family: "csv-aggregation",
  humanMinutes: 2,
  messiness: "low",
  prompt: "`data/sales.csv` lists sales. Compute the total of the `amount` column, rounded to 2 decimals. Output: {\"total\": number}.",
  inputs: { "data/sales.csv": "id,region,amount\n1,US,120.50\n2,EU,80.25\n3,US,19.99\n4,APAC,305.00\n5,EU,44.10\n" },
  outputPath: "out/total.json",
  solve: (i) => ({ total: round(parseCSV(i["data/sales.csv"]!).reduce((s, r) => s + num(r.amount), 0)) }),
  wrong: (i) => ({ total: round(parseCSV(i["data/sales.csv"]!).slice(0, -1).reduce((s, r) => s + num(r.amount), 0)) }),
});

// 2 — 6 min
const regionTotals = defineOutputTask({
  id: "region-totals",
  title: "Totals by region",
  family: "csv-aggregation",
  humanMinutes: 6,
  messiness: "low",
  prompt: "Using `data/sales.csv`, total `amount` per `region` (2 decimals). Output an object mapping region to total.",
  inputs: { "data/sales.csv": "id,region,amount\n1,US,120.50\n2,EU,80.25\n3,US,19.99\n4,APAC,305.00\n5,EU,44.10\n6,APAC,12.00\n" },
  outputPath: "out/regions.json",
  solve: (i) => {
    const m = new Map<string, number>();
    for (const r of parseCSV(i["data/sales.csv"]!)) m.set(r.region!, (m.get(r.region!) ?? 0) + num(r.amount));
    return sortedObject([...m].map(([k, v]) => [k, round(v)]));
  },
  wrong: () => ({ US: 140.49, EU: 124.35, APAC: 305 }),
});

// 3 — 8 min (holdout)
const redactNotes = defineOutputTask({
  id: "redact-notes",
  title: "Redact contact details",
  family: "text-cleaning",
  humanMinutes: 8,
  messiness: "low",
  holdout: true,
  prompt:
    "Redact every email address in `notes.txt` as `[EMAIL]` and every phone number of the form NNN-NNN-NNNN as `[PHONE]`. Keep all other text exactly. Output: {\"redacted\": string}.",
  inputs: { "notes.txt": "Call Dana at 718-555-0142 or dana.r@example.org.\nBackup: ops@example.com, 212-555-0199.\nTicket 12-34 stays." },
  outputPath: "out/redacted.json",
  solve: (i) => ({
    redacted: i["notes.txt"]!.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[EMAIL]").replace(/\b\d{3}-\d{3}-\d{4}\b/g, "[PHONE]"),
  }),
  wrong: (i) => ({ redacted: i["notes.txt"]!.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[EMAIL]") }),
});

// 4 — 10 min
const dedupeContacts = defineOutputTask({
  id: "dedupe-contacts",
  title: "Deduplicate contacts",
  family: "data-cleaning",
  humanMinutes: 10,
  messiness: "low",
  prompt:
    "`contacts.csv` has duplicate emails with different case and stray spaces. Produce the unique emails, lowercased and trimmed, sorted ascending. Output: {\"count\": number, \"unique\": string[]}.",
  inputs: { "contacts.csv": "name,email\nAna,ana@corp.io\nBen, Ben@Corp.io\nana2,ANA@corp.io \nCy,cy@corp.io\nBen B,ben@corp.io\n" },
  outputPath: "out/contacts.json",
  solve: (i) => {
    const u = [...new Set(parseCSV(i["contacts.csv"]!).map((r) => r.email!.trim().toLowerCase()))].sort();
    return { count: u.length, unique: u };
  },
  wrong: (i) => {
    const u = [...new Set(parseCSV(i["contacts.csv"]!).map((r) => r.email!.trim()))].sort();
    return { count: u.length, unique: u };
  },
});

// 5 — 15 min
function flatten(o: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (o !== null && typeof o === "object" && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = o;
  return out;
}
const configFlatten = defineOutputTask({
  id: "config-flatten",
  title: "Flatten a nested config",
  family: "json-transform",
  humanMinutes: 15,
  messiness: "low",
  prompt: "Flatten `config.json` into a single object with dotted keys (e.g. `db.pool.max`). Arrays are leaf values and stay as arrays.",
  inputs: {
    "config.json": JSON.stringify({ db: { host: "db.local", pool: { min: 2, max: 10 } }, features: { mesh: true, regions: ["us", "eu"] }, version: 3 }, null, 2),
  },
  outputPath: "out/flat.json",
  solve: (i) => flatten(JSON.parse(i["config.json"]!)),
  wrong: (i) => {
    const f = flatten(JSON.parse(i["config.json"]!));
    delete f["features.regions"];
    return f;
  },
});

// 6 — 20 min
const payroll = defineOutputTask({
  id: "timesheet-payroll",
  title: "Weekly payroll with overtime",
  family: "finance-ops",
  humanMinutes: 20,
  messiness: "low",
  prompt:
    "`hours.csv` has weekly hours and hourly rate per employee. Hours above 40 are paid at 1.5× the rate. Output an object mapping employee to gross pay (2 decimals), plus a key `_total` for the sum.",
  inputs: { "hours.csv": "employee,hours,rate\nalvarez,38,24.00\nbishop,46,30.00\nchen,40,28.50\ndiaz,52.5,22.00\n" },
  outputPath: "out/payroll.json",
  solve: (i) => {
    const pay = parseCSV(i["hours.csv"]!).map((r): [string, number] => {
      const h = num(r.hours);
      const rate = num(r.rate);
      return [r.employee!, round(Math.min(h, 40) * rate + Math.max(0, h - 40) * rate * 1.5)];
    });
    return sortedObject([...pay, ["_total", round(pay.reduce((s, [, v]) => s + v, 0))]]);
  },
  wrong: (i) => sortedObject(parseCSV(i["hours.csv"]!).map((r) => [r.employee!, round(num(r.hours) * num(r.rate))])),
});

// 7 — 30 min, messy
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function normalizeDate(s: string): string {
  const t = s.trim();
  const pad = (n: number) => String(n).padStart(2, "0");
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return t;
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return `${m[3]}-${pad(+m[1]!)}-${pad(+m[2]!)}`;
  if ((m = t.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/))) return `${m[3]}-${pad(MONTHS[m[2]!.toLowerCase()]!)}-${pad(+m[1]!)}`;
  if ((m = t.match(/^([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})$/))) return `${m[3]}-${pad(MONTHS[m[1]!.toLowerCase()]!)}-${pad(+m[2]!)}`;
  throw new Error(`unrecognized date: ${s}`);
}
const dateNormalize = defineOutputTask({
  id: "date-normalize",
  title: "Normalize mixed date formats",
  family: "data-cleaning",
  humanMinutes: 30,
  messiness: "high",
  prompt:
    "`dates.txt` has one date per line in mixed formats exported by different offices. Read `OFFICES.md` for how each office writes dates. Convert every date to ISO `YYYY-MM-DD`, keeping line order. Output: {\"dates\": string[]}.",
  inputs: {
    "dates.txt": "2026-03-04\n03/04/2026\n4 Mar 2026\nMarch 14, 2026\n12/01/2026\n1 December 2026\n",
    "OFFICES.md": "Our US office exports month-first slash dates (MM/DD/YYYY).\nLondon writes day-month-name (4 Mar 2026). Everyone else uses ISO or long US form.\nThere are no day-first slash dates in this file.",
  },
  outputPath: "out/dates.json",
  solve: (i) => ({ dates: i["dates.txt"]!.split("\n").filter((l) => l.trim()).map(normalizeDate) }),
  wrong: () => ({ dates: ["2026-03-04", "2026-04-03", "2026-03-04", "2026-03-14", "2026-01-12", "2026-12-01"] }),
});

// 8 — 45 min, messy
const logIncident = defineOutputTask({
  id: "log-incident",
  title: "Incident timeline from logs",
  family: "log-analysis",
  humanMinutes: 45,
  messiness: "high",
  prompt:
    "From `app.log`, find the first and last ERROR timestamps, count lines per level, and the longest gap (seconds) between consecutive ERROR lines. Some lines are multi-line stack-trace continuations (they start with whitespace) — ignore them. Output: {\"first_error\": timestamp exactly as written in the log, \"last_error\": same, \"counts\": {level: number of lines}, \"max_error_gap_s\": number of seconds}.",
  inputs: {
    "app.log": [
      "2026-09-01T10:00:00Z INFO boot",
      "2026-09-01T10:00:03Z WARN slow disk",
      "2026-09-01T10:01:10Z ERROR db timeout",
      "    at Pool.acquire (pool.js:44)",
      "2026-09-01T10:01:15Z INFO retry",
      "2026-09-01T10:04:00Z ERROR db timeout",
      "2026-09-01T10:04:30Z WARN queue depth 900",
      "2026-09-01T10:09:45Z ERROR mesh link down",
      "    at Link.ping (link.js:12)",
      "2026-09-01T10:10:00Z INFO recovered",
    ].join("\n"),
  },
  outputPath: "out/incident.json",
  solve: (i) => {
    const lines = i["app.log"]!.split("\n").filter((l) => l && !/^\s/.test(l));
    const counts = new Map<string, number>();
    const errors: number[] = [];
    const errorTs: string[] = [];
    for (const l of lines) {
      const [ts, level] = l.split(" ");
      counts.set(level!, (counts.get(level!) ?? 0) + 1);
      if (level === "ERROR") {
        errors.push(Date.parse(ts!));
        errorTs.push(ts!);
      }
    }
    let gap = 0;
    for (let k = 1; k < errors.length; k++) gap = Math.max(gap, (errors[k]! - errors[k - 1]!) / 1000);
    return { first_error: errorTs[0], last_error: errorTs.at(-1), counts: sortedObject([...counts]), max_error_gap_s: gap };
  },
  wrong: () => ({ first_error: "2026-09-01T10:01:10Z", last_error: "2026-09-01T10:09:45Z", counts: { ERROR: 3, INFO: 3, WARN: 2, "": 2 }, max_error_gap_s: 345 }),
});

// 9 — 60 min, messy
const invoiceReconcile = defineOutputTask({
  id: "invoice-reconcile",
  title: "Reconcile invoices against payments",
  family: "finance-ops",
  humanMinutes: 60,
  messiness: "high",
  prompt:
    "Match `payments.csv` to `invoices.csv` by invoice id. Payment references are typed by hand: ids may differ in case and spacing (e.g. ` inv-003`). An invoice can be paid in several parts. Use the canonical upper-case ids from `invoices.csv`. Output: {\"unpaid\": ids with any balance due (sorted), \"overpaid\": ids paid more than billed (sorted), \"balance_due\": sum of the positive balances only — overpayments do not offset other invoices — 2 decimals}.",
  inputs: {
    "invoices.csv": "invoice,amount\nINV-001,500.00\nINV-002,1200.00\nINV-003,75.50\nINV-004,300.00\nINV-005,980.00\n",
    "payments.csv": "ref,amount\ninv-001,500.00\nINV-002,600.00\n inv-002 ,500.00\nINV-003,80.00\nInv-005,980.00\n",
  },
  outputPath: "out/reconcile.json",
  solve: (i) => {
    const billed = new Map(parseCSV(i["invoices.csv"]!).map((r) => [r.invoice!.toUpperCase(), num(r.amount)]));
    const paid = new Map<string, number>();
    for (const p of parseCSV(i["payments.csv"]!)) {
      const id = p.ref!.trim().toUpperCase();
      paid.set(id, (paid.get(id) ?? 0) + num(p.amount));
    }
    const unpaid: string[] = [];
    const overpaid: string[] = [];
    let due = 0;
    for (const [id, amt] of billed) {
      const d = round(amt - (paid.get(id) ?? 0));
      if (d > 0) {
        unpaid.push(id);
        due += d;
      } else if (d < 0) overpaid.push(id);
    }
    return { unpaid: unpaid.sort(), overpaid: overpaid.sort(), balance_due: round(due) };
  },
  wrong: () => ({ unpaid: ["INV-002", "INV-004"], overpaid: ["INV-003"], balance_due: 600 }),
});

// 10 — 90 min
const inventoryReorder = defineOutputTask({
  id: "inventory-reorder",
  title: "Compute reorder quantities",
  family: "ops-planning",
  humanMinutes: 90,
  messiness: "low",
  prompt:
    "For each SKU in `inventory.csv`, the reorder point is daily_usage × (lead_days + safety_days). If on_hand is below the reorder point, order ceil(daily_usage × (lead_days + safety_days + 30)) − on_hand units. Output {\"orders\": [{\"sku\", \"qty\"}] sorted by sku}, only SKUs that need ordering.",
  inputs: {
    "inventory.csv": "sku,on_hand,daily_usage,lead_days,safety_days\nA-100,40,5,7,3\nA-200,500,12,10,5\nB-310,90,7.5,14,4\nC-020,0,1.2,30,10\nD-777,61,3,15,5\n",
  },
  outputPath: "out/reorder.json",
  solve: (i) => ({
    orders: parseCSV(i["inventory.csv"]!)
      .map((r) => {
        const use = num(r.daily_usage);
        const cover = num(r.lead_days) + num(r.safety_days);
        const onHand = num(r.on_hand);
        return { sku: r.sku!, need: onHand < use * cover, qty: Math.ceil(use * (cover + 30)) - onHand };
      })
      .filter((r) => r.need)
      .map(({ sku, qty }) => ({ qty, sku }))
      .sort((a, b) => (a.sku < b.sku ? -1 : 1)),
  }),
  wrong: () => ({ orders: [{ sku: "A-100", qty: 160 }, { sku: "B-310", qty: 315 }, { sku: "C-020", qty: 84 }] }),
});

// 11 — 120 min
function dijkstra(edgesCsv: string, from: string, to: string): { cost: number; path: string[] } {
  const adj = new Map<string, [string, number][]>();
  for (const e of parseCSV(edgesCsv)) {
    if (!adj.has(e.from!)) adj.set(e.from!, []);
    adj.get(e.from!)!.push([e.to!, num(e.cost)]);
  }
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  while (true) {
    let u: string | undefined;
    for (const [k, d] of dist) if (!done.has(k) && (u === undefined || d < dist.get(u)! || (d === dist.get(u)! && k < u))) u = k;
    if (u === undefined || u === to) break;
    done.add(u);
    for (const [v, c] of adj.get(u) ?? []) {
      const nd = dist.get(u)! + c;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, u);
      }
    }
  }
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]!)!);
  return { cost: dist.get(to)!, path };
}
const shortestPath = defineOutputTask({
  id: "shortest-route",
  title: "Cheapest route through a network",
  family: "graph-algorithms",
  humanMinutes: 120,
  messiness: "low",
  prompt: "`edges.csv` is a directed graph (from,to,cost). Find the cheapest path from node A to node H. Output: {\"cost\": number, \"path\": string[]}.",
  inputs: { "edges.csv": "from,to,cost\nA,B,4\nA,C,2\nC,B,1\nB,D,5\nC,D,8\nC,E,10\nD,E,2\nD,F,6\nE,F,2\nE,G,7\nF,H,3\nG,H,1\nB,G,12\n" },
  outputPath: "out/route.json",
  solve: (i) => dijkstra(i["edges.csv"]!, "A", "H"),
  wrong: () => ({ cost: 16, path: ["A", "B", "D", "F", "H"] }),
});

// 12 — 180 min, messy
const abTest = defineOutputTask({
  id: "ab-test-analysis",
  title: "Clean A/B test analysis",
  family: "analytics",
  humanMinutes: 180,
  messiness: "high",
  prompt:
    "Analyze `events.csv` (user,variant,converted). Read `ANALYSIS_NOTES.md` for the cleaning rules the data team agreed on. Output: {\"n\": {variant: users}, \"rate\": {variant: conversion rate, 4 decimals}, \"lift\": rate(B) − rate(A) computed from the rounded rates, 4 decimals, \"excluded_users\": sorted ids}.",
  inputs: {
    "events.csv": "user,variant,converted\nu1,A,0\nu2,A,1\nu3,B,1\nu4,B,0\nu2,A,0\nu5,B,1\nu6,A,0\nu7,B,1\nu6,B,1\nu8,A,1\nu9,B,0\nu10,A,0\n",
    "ANALYSIS_NOTES.md":
      "- If a user appears more than once in the same variant, keep only their FIRST row.\n- Users who appear in BOTH variants are contaminated: exclude them entirely.\n- Rates are conversions / users after cleaning.",
  },
  outputPath: "out/abtest.json",
  solve: (i) => {
    const rows = parseCSV(i["events.csv"]!);
    const variants = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!variants.has(r.user!)) variants.set(r.user!, new Set());
      variants.get(r.user!)!.add(r.variant!);
    }
    const excluded = [...variants].filter(([, v]) => v.size > 1).map(([u]) => u).sort();
    const first = new Map<string, Record<string, string>>();
    for (const r of rows) if (!excluded.includes(r.user!) && !first.has(r.user!)) first.set(r.user!, r);
    const n: Record<string, number> = { A: 0, B: 0 };
    const conv: Record<string, number> = { A: 0, B: 0 };
    for (const r of first.values()) {
      n[r.variant!]! += 1;
      conv[r.variant!]! += num(r.converted);
    }
    const rate = { A: round(conv.A! / n.A!, 4), B: round(conv.B! / n.B!, 4) };
    return { n, rate, lift: round(rate.B - rate.A, 4), excluded_users: excluded };
  },
  wrong: () => ({ n: { A: 6, B: 6 }, rate: { A: 0.3333, B: 0.6667 }, lift: 0.3333, excluded_users: [] }),
});

// 13 — 240 min, messy
const meetingSlots = defineOutputTask({
  id: "meeting-slots",
  title: "Find meeting slots across time zones",
  family: "scheduling",
  humanMinutes: 240,
  messiness: "high",
  prompt:
    "`calendars.json` lists three people with their UTC offset and busy intervals in LOCAL time on 2026-10-14. Each person works 09:00–17:00 local. Find every 60-minute slot, starting on a :00 or :30 boundary in UTC, when all three are free and inside working hours. Output: {\"slots_utc\": [\"HH:MM\", ...]} in ascending order.",
  inputs: {
    "calendars.json": JSON.stringify(
      {
        date: "2026-10-14",
        people: [
          { name: "Mamba", utc_offset_hours: -4, busy: [["09:00", "10:30"], ["13:00", "14:00"]] },
          { name: "Ines", utc_offset_hours: 1, busy: [["15:00", "15:30"]] },
          { name: "Sol", utc_offset_hours: 0, busy: [["14:00", "14:30"]] },
        ],
      },
      null,
      2,
    ),
  },
  outputPath: "out/slots.json",
  solve: (i) => {
    const cal = JSON.parse(i["calendars.json"]!) as { people: { utc_offset_hours: number; busy: [string, string][] }[] };
    const mins = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3);
    const slots: string[] = [];
    for (let start = 0; start + 60 <= 24 * 60; start += 30) {
      const end = start + 60;
      const ok = cal.people.every((p) => {
        const off = p.utc_offset_hours * 60;
        const ls = start + off;
        const le = end + off;
        if (ls < 9 * 60 || le > 17 * 60) return false;
        return p.busy.every(([b, e]) => le <= mins(b) || ls >= mins(e));
      });
      if (ok) slots.push(`${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}`);
    }
    return { slots_utc: slots };
  },
  wrong: () => ({ slots_utc: ["13:00", "13:30", "15:00"] }),
});

// 14 — 480 min, messy
const slaBreach = defineOutputTask({
  id: "sla-breach-audit",
  title: "Audit support SLA breaches",
  family: "ops-planning",
  humanMinutes: 480,
  messiness: "high",
  prompt:
    "Using `tickets.csv` and the policy in `SLA_POLICY.md`, list every ticket that breached its SLA (including still-open tickets already past their deadline at the report time). Output: {\"breached\": sorted ticket ids, \"breach_rate_by_priority\": {priority: breached / all tickets of that priority in the file (including open tickets not yet due), 4 decimals}}.",
  inputs: {
    "tickets.csv":
      "id,priority,created,resolved\nT1,P1,2026-09-30T08:00:00Z,2026-09-30T11:30:00Z\nT2,P1,2026-09-30T09:00:00Z,2026-09-30T14:00:00Z\nT3,P2,2026-09-29T10:00:00Z,2026-09-30T09:00:00Z\nT4,P2,2026-09-29T10:00:00Z,2026-09-30T12:00:00Z\nT5,P3,2026-09-25T10:00:00Z,\nT6,P3,2026-09-28T10:00:00Z,\nT7,P1,2026-10-01T07:30:00Z,\n",
    "SLA_POLICY.md":
      "Resolution targets: P1 within 4 hours, P2 within 24 hours, P3 within 5 days (120 hours).\nOpen tickets (no resolved time) are measured against the report time: 2026-10-01T10:00:00Z.\nA ticket resolved exactly at its deadline is NOT a breach.",
  },
  outputPath: "out/sla.json",
  solve: (i) => {
    const limit: Record<string, number> = { P1: 4, P2: 24, P3: 120 };
    const report = Date.parse("2026-10-01T10:00:00Z");
    const breached: string[] = [];
    const tot = new Map<string, number>();
    const br = new Map<string, number>();
    for (const t of parseCSV(i["tickets.csv"]!)) {
      const end = t.resolved ? Date.parse(t.resolved) : report;
      const hours = (end - Date.parse(t.created!)) / 3_600_000;
      tot.set(t.priority!, (tot.get(t.priority!) ?? 0) + 1);
      if (hours > limit[t.priority!]!) {
        breached.push(t.id!);
        br.set(t.priority!, (br.get(t.priority!) ?? 0) + 1);
      }
    }
    return { breached: breached.sort(), breach_rate_by_priority: sortedObject([...tot].map(([p, n]) => [p, round((br.get(p) ?? 0) / n, 4)])) };
  },
  wrong: () => ({ breached: ["T2", "T4"], breach_rate_by_priority: { P1: 0.3333, P2: 0.5, P3: 0 } }),
});

// 15 — 480 min
const releasePlan = defineOutputTask({
  id: "release-plan",
  title: "Release plan: order and critical path",
  family: "graph-algorithms",
  humanMinutes: 480,
  messiness: "low",
  maxSteps: 80,
  prompt:
    "`workstreams.json` maps each workstream to {days, depends_on}. Produce a valid build order (Kahn's algorithm; when several are ready, take the alphabetically first), the critical path (longest-duration dependency chain, listed start to finish) and its total days. Output: {\"order\": [...], \"critical_path\": [...], \"duration_days\": number}.",
  inputs: {
    "workstreams.json": JSON.stringify(
      {
        api: { days: 5, depends_on: ["schema"] },
        auth: { days: 3, depends_on: ["schema"] },
        docs: { days: 2, depends_on: ["api"] },
        mesh: { days: 8, depends_on: [] },
        schema: { days: 2, depends_on: [] },
        sync: { days: 4, depends_on: ["mesh", "api"] },
        ui: { days: 6, depends_on: ["api", "auth"] },
        release: { days: 1, depends_on: ["ui", "sync", "docs"] },
      },
      null,
      2,
    ),
  },
  outputPath: "out/plan.json",
  solve: (i) => {
    const ws = JSON.parse(i["workstreams.json"]!) as Record<string, { days: number; depends_on: string[] }>;
    const indeg = new Map(Object.keys(ws).map((k) => [k, ws[k]!.depends_on.length]));
    const order: string[] = [];
    const ready = [...indeg].filter(([, d]) => d === 0).map(([k]) => k);
    while (ready.length) {
      ready.sort();
      const k = ready.shift()!;
      order.push(k);
      for (const [n, w] of Object.entries(ws)) {
        if (w.depends_on.includes(k)) {
          indeg.set(n, indeg.get(n)! - 1);
          if (indeg.get(n) === 0) ready.push(n);
        }
      }
    }
    const finish = new Map<string, number>();
    const via = new Map<string, string | undefined>();
    for (const k of order) {
      let best = 0;
      let from: string | undefined;
      for (const d of ws[k]!.depends_on) if (finish.get(d)! > best) [best, from] = [finish.get(d)!, d];
      finish.set(k, best + ws[k]!.days);
      via.set(k, from);
    }
    let end = order[0]!;
    for (const k of order) if (finish.get(k)! > finish.get(end)!) end = k;
    const path = [end];
    while (via.get(path[0]!)) path.unshift(via.get(path[0]!)!);
    return { order, critical_path: path, duration_days: finish.get(end)! };
  },
  wrong: () => ({ order: ["mesh", "schema", "api", "auth", "docs", "sync", "ui", "release"], critical_path: ["mesh", "sync", "release"], duration_days: 13 }),
});

// 16 — 960 min, messy
const budgetConsolidation = defineOutputTask({
  id: "budget-consolidation",
  title: "Consolidate multi-currency budgets",
  family: "finance-ops",
  humanMinutes: 960,
  messiness: "high",
  maxSteps: 100,
  prompt:
    "Consolidate the three department budgets in `budgets/` into USD using `fx.json`. Follow `FINANCE_MEMO.md` exactly: it explains duplicates, refunds and which rate to use. Output: {\"by_department\": {dept: USD total, 2 decimals}, \"grand_total\": number, \"excluded_lines\": sorted line ids}.",
  inputs: {
    "budgets/eng.csv": "line,dept,currency,amount,note\nE1,eng,USD,12000,\nE2,eng,EUR,4000,\nE3,eng,EUR,4000,duplicate of E2\nE4,eng,USD,-500,refund\n",
    "budgets/ops.csv": "line,dept,currency,amount,note\nO1,ops,GBP,2500,\nO2,ops,USD,800,\nO3,ops,GBP,-200,refund\nO4,ops,USD,800,DUPLICATE of O2\n",
    "budgets/field.csv": "line,dept,currency,amount,note\nF1,field,MXN,90000,\nF2,field,USD,1500,\nF3,field,MXN,9000,pending approval\n",
    "fx.json": JSON.stringify({ month_end: { EUR: 1.09, GBP: 1.27, MXN: 0.054 }, average: { EUR: 1.08, GBP: 1.26, MXN: 0.055 } }, null, 2),
    "FINANCE_MEMO.md":
      "1. Lines whose note says they duplicate another line (any capitalization) are excluded.\n2. Lines marked 'pending approval' are excluded.\n3. Refunds (negative amounts) are kept; they reduce the total.\n4. Convert with MONTH-END rates, not the average.\n5. Round each department total to 2 decimals; the grand total is the sum of the rounded department totals.",
  },
  outputPath: "out/budget.json",
  solve: (i) => {
    const fx = (JSON.parse(i["fx.json"]!) as { month_end: Record<string, number> }).month_end;
    const totals = new Map<string, number>();
    const excluded: string[] = [];
    for (const f of ["budgets/eng.csv", "budgets/ops.csv", "budgets/field.csv"]) {
      for (const r of parseCSV(i[f]!)) {
        const note = (r.note ?? "").toLowerCase();
        if (note.includes("duplicate of") || note.includes("pending approval")) {
          excluded.push(r.line!);
          continue;
        }
        const rate = r.currency === "USD" ? 1 : fx[r.currency!]!;
        totals.set(r.dept!, (totals.get(r.dept!) ?? 0) + num(r.amount) * rate);
      }
    }
    const by = sortedObject([...totals].map(([d, v]) => [d, round(v)]));
    return { by_department: by, grand_total: round(Object.values(by).reduce((s, v) => s + v, 0)), excluded_lines: excluded.sort() };
  },
  wrong: () => ({ by_department: { eng: 15820, field: 6450, ops: 3943 }, grand_total: 26213, excluded_lines: ["E3", "F3"] }),
});

export const exampleSuite: Task[] = [
  salesTotal,
  regionTotals,
  redactNotes,
  dedupeContacts,
  configFlatten,
  payroll,
  dateNormalize,
  logIncident,
  invoiceReconcile,
  inventoryReorder,
  shortestPath,
  abTest,
  meetingSlots,
  slaBreach,
  releasePlan,
  budgetConsolidation,
];
