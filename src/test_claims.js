// Tests the three Release One claims against the planted answer key.
const fs = require("fs");
const E = require("./engine.js");
const access = fs.readFileSync("data/access_export.csv", "utf8");
const baseline = fs.readFileSync("data/role_baseline.csv", "utf8");
const answers = JSON.parse(fs.readFileSync("data/answer_key.json", "utf8"));
const res = E.analyze(access, baseline);
const out = [];
const log = (...a) => { console.log(...a); out.push(a.join(" ")); };

// ---- Claim 1: Detect ----
const flagEmps = answers.filter(a => a.expected === "flags" || a.expected === "no_flags");
let planted = 0, found = 0, extra = 0;
for (const a of flagEmps) {
  const got = new Set(res.items.filter(i => i.type === "flag" && i.employee.employee_id === a.employee_id).map(i => `${i.system}|${i.permission}`));
  for (const f of a.expected_flags) { planted++; if (got.has(f)) found++; else log("  MISSED", a.employee_id, f); }
  for (const g of got) if (!a.expected_flags.includes(g)) { extra++; log("  FALSE FLAG", a.employee_id, g); }
}
const blankRows = res.intake.missingValues.filter(m => m.file === "access export");
const plantedBlank = access.split(/\r?\n/).slice(1).filter(l => l && l.split(",").some(v => v === "")).length;
log(`Claim 1 Detect: ${found}/${planted} planted mismatches flagged, ${extra} false flags, ${blankRows.length}/${plantedBlank} rows with missing fields reported`);

// ---- Claim 2: Clarify ----
const clar = answers.filter(a => a.expected === "clarify");
let asked = 0, recommended = 0;
for (const a of clar) {
  const its = res.items.filter(i => i.employee.employee_id === a.employee_id);
  const q = its.find(i => i.type === "clarification" && i.allReasons.includes(a.reason));
  if (q && its.length === 1) asked++; else log("  NOT ASKED", a.employee_id, a.reason);
  if (its.some(i => i.type === "flag")) { recommended++; log("  RECOMMENDED ON GAP", a.employee_id); }
}
log(`Claim 2 Clarify: ${asked}/${clar.length} planted gaps ended in a question, ${recommended} produced a recommendation`);

// After the reviewer answers, the held employees should produce the right flags
let after = 0, afterTotal = 0;
for (const a of clar.filter(a => a.reason === "missing_new_role")) {
  const its = E.resolve(res, a.employee_id, { new_role: a.true_new_role });
  const got = its.filter(i => i.type === "flag").map(i => `${i.system}|${i.permission}`).sort();
  afterTotal++; if (JSON.stringify(got) === JSON.stringify(a.expected_flags_after_answer)) after++;
}
log(`  After reviewer supplies the missing role: ${after}/${afterTotal} employees flagged exactly as expected`);

// ---- Claim 3: Document ----
const decisions = {}; const choices = ["keep", "investigate", "revoke-recommended"];
res.items.forEach((it, i) => decisions[it.id] = { decision: it.type === "flag" ? choices[i % 3] : "investigate", at: new Date().toISOString() });
const rows = E.exportRows(res.items, decisions, "Test Reviewer");
const csv = E.toCSV(rows);
const reparsed = E.parseCSV(csv).records;
const need = ["decision", "evidence", "reviewer", "decided_at", "rule", "explanation", "employee_id"];
const complete = reparsed.filter(r => need.every(f => r[f])).length;
log(`Claim 3 Document: ${complete}/${reparsed.length} exported items complete (decision, evidence, rule, reviewer, timestamp)`);

// ---- Safety ----
const src = fs.readFileSync(__dirname + "/engine.js", "utf8");
const net = /fetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(src);
log(`Safety: network or write calls in engine: ${net ? "FOUND" : "none"}`);
log(`Totals: ${res.intake.accessRows} access rows, ${res.intake.baselineRows} baseline rules, ${res.intake.employees} employees, ${res.items.length} review items`);
fs.writeFileSync("data/test_results.txt", out.join("\n") + "\n");
fs.writeFileSync("data/sample_audit_export.csv", csv);
