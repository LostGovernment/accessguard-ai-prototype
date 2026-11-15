// AccessGuard AI prototype engine. Pure functions, no network, no write path to any IAM system.
// Rules decide what is flagged. Explanations are template text built from the same rows and rules,
// standing in for the foundation-model step described in the deck.

const ACCESS_FIELDS = ["employee_id", "employee_name", "previous_role", "new_role", "change_date", "system", "permission"];
const BASELINE_FIELDS = ["role", "system", "permission", "rule_id"];

function parseCSV(text) {
  const rows = []; let row = []; let field = ""; let q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(v => v.trim() !== ""));
  if (!nonEmpty.length) return { headers: [], records: [] };
  const headers = nonEmpty[0].map(h => h.trim().toLowerCase());
  const records = [];
  // line numbers: keep the original file line so evidence points at the real row
  let line = 0;
  for (const r of rows) {
    line++;
    if (r === nonEmpty[0] || !r.some(v => v.trim() !== "")) continue;
    const o = { _line: line };
    headers.forEach((h, j) => { o[h] = (r[j] || "").trim(); });
    records.push(o);
  }
  return { headers, records };
}

function checkFields(parsed, required, fileLabel) {
  const missingColumns = required.filter(f => !parsed.headers.includes(f));
  const missingValues = [];
  for (const r of parsed.records)
    for (const f of required)
      if (parsed.headers.includes(f) && !r[f]) missingValues.push({ file: fileLabel, line: r._line, field: f, employee_id: r.employee_id || "" });
  return { missingColumns, missingValues };
}

const key = (s, p) => `${s}|${p}`.toLowerCase();

function buildBaseline(records) {
  const byRole = new Map();
  for (const r of records) {
    if (!r.role || !r.system || !r.permission) continue;
    if (!byRole.has(r.role)) byRole.set(r.role, new Map());
    byRole.get(r.role).set(key(r.system, r.permission), r);
  }
  return byRole;
}

function rulesFor(baseline, role, system) {
  const m = baseline.get(role); if (!m) return [];
  return [...m.values()].filter(r => r.system.toLowerCase() === system.toLowerCase());
}

function ruleRange(baseline, role) {
  const ids = [...(baseline.get(role) || new Map()).values()].map(r => r.rule_id).sort();
  return ids.length ? `${ids[0]} to ${ids[ids.length - 1]}` : "none";
}

function explainFlag(emp, row, baseline) {
  const name = emp.employee_name || emp.employee_id;
  const sameSystem = rulesFor(baseline, emp.new_role, row.system);
  const prevRule = (baseline.get(emp.previous_role) || new Map()).get(key(row.system, row.permission));
  let s = `${name} moved from ${emp.previous_role || "an unrecorded role"} to ${emp.new_role} on ${emp.change_date || "an unrecorded date"}. `;
  s += `Row ${row._line} of the access export shows ${row.system} "${row.permission}". `;
  if (sameSystem.length)
    s += `The ${emp.new_role} baseline grants ${row.system} access only as ${sameSystem.map(r => `"${r.permission}" (${r.rule_id})`).join(", ")}, so this permission is outside the new role. `;
  else
    s += `The ${emp.new_role} baseline (rules ${ruleRange(baseline, emp.new_role)}) grants no ${row.system} access at all. `;
  if (prevRule)
    s += `It matches rule ${prevRule.rule_id} for the previous role, which suggests it was left over from before the move. Confirm with the ${row.system} owner before recommending revocation.`;
  else
    s += `It is not in the baseline for the previous role either, so it may have been granted as a one-off exception. Look for an approval record before deciding.`;
  return s;
}

function analyze(accessText, baselineText) {
  const A = parseCSV(accessText), B = parseCSV(baselineText);
  const accessCheck = checkFields(A, ACCESS_FIELDS, "access export");
  // employee_name and previous_role are helpful context but not required to run the comparison
  const blocking = ["employee_id", "new_role", "system", "permission"];
  const bCheck = checkFields(B, BASELINE_FIELDS, "role baseline");
  const intake = {
    accessRows: A.records.length, baselineRows: B.records.length,
    missingColumns: [...accessCheck.missingColumns.map(c => `access export: ${c}`), ...bCheck.missingColumns.map(c => `role baseline: ${c}`)],
    missingValues: [...accessCheck.missingValues, ...bCheck.missingValues],
    ok: false, employees: 0, roles: 0
  };
  const fatal = ["employee_id", "new_role", "system", "permission"].filter(c => !A.headers.includes(c)).length || bCheck.missingColumns.length;
  if (fatal) return { intake, items: [], employees: [] };
  const baseline = buildBaseline(B.records);
  intake.roles = baseline.size; intake.ok = true;

  const groups = new Map();
  for (const r of A.records) {
    if (!r.employee_id) continue; // reported as a missing value; cannot be attributed
    if (!groups.has(r.employee_id)) groups.set(r.employee_id, []);
    groups.get(r.employee_id).push(r);
  }
  intake.employees = groups.size;
  const employees = [], items = [];
  for (const [eid, rows] of groups) {
    const emp = summarize(eid, rows);
    employees.push(emp);
    items.push(...evaluate(emp, rows, baseline, null));
  }
  return { intake, items, employees, _baseline: baseline, _groups: groups };
}

function summarize(eid, rows) {
  const pick = f => { const v = rows.map(r => r[f]).filter(Boolean); return v[0] || ""; };
  return { employee_id: eid, employee_name: pick("employee_name"), previous_role: pick("previous_role"),
           new_role: pick("new_role"), change_date: pick("change_date"), rowCount: rows.length,
           roles_seen: [...new Set(rows.map(r => r.new_role).filter(Boolean))] };
}

// answer: { new_role?: string, ignoreBlankRows?: bool } supplied by the reviewer for a clarification
function evaluate(emp, rows, baseline, answer) {
  const issues = [];
  const blankRole = rows.filter(r => !r.new_role);
  const blankPerm = rows.filter(r => !r.system || !r.permission);
  let role = emp.roles_seen.length === 1 ? emp.roles_seen[0] : "";
  if (answer && answer.new_role) role = answer.new_role;
  else {
    if (emp.roles_seen.length > 1)
      issues.push({ reason: "conflicting_new_role", lines: rows.filter(r => r.new_role).map(r => r._line),
        question: `The export lists more than one new role for ${emp.employee_name || emp.employee_id}: ${emp.roles_seen.join(" and ")}. Which role is correct?`,
        options: emp.roles_seen });
    else if (blankRole.length)
      issues.push({ reason: "missing_new_role", lines: blankRole.map(r => r._line),
        question: `${blankRole.length === rows.length ? "No row" : `${blankRole.length} of ${rows.length} rows`} for ${emp.employee_name || emp.employee_id} ${blankRole.length === rows.length ? "records" : "are missing"} a new role. What role did this employee move into?`,
        options: [...baseline.keys()] });
  }
  if (role && !baseline.has(role))
    issues.push({ reason: "no_baseline_for_role", lines: rows.map(r => r._line),
      question: `There is no role-permission baseline for "${role}". Add a baseline for this role, or confirm which existing role it should be compared with.`,
      options: [...baseline.keys()] });
  if (blankPerm.length && !(answer && answer.ignoreBlankRows))
    issues.push({ reason: "missing_permission_value", lines: blankPerm.map(r => r._line),
      question: `Row ${blankPerm.map(r => r._line).join(", ")} for ${emp.employee_name || emp.employee_id} has a blank system or permission. Confirm whether the row can be ignored, or correct the export and upload it again.`,
      options: ["ignore"] });

  const effective = { ...emp, new_role: role };
  if (issues.length) {
    const it = issues[0];
    return [{ id: `${emp.employee_id}-Q`, type: "clarification", employee: effective, reason: it.reason, allReasons: issues.map(i => i.reason),
      question: it.question, options: it.options, evidence: `Access export ${new Set(it.lines).size === 1 ? "row" : "rows"} ${compact(it.lines)}`,
      rule: { no_baseline_for_role: "No baseline rule available", conflicting_new_role: "Role must be unambiguous before comparison",
              missing_new_role: "Role must be known before comparison", missing_permission_value: "Every row needs a system and permission" }[it.reason],
      explanation: `${it.question} No recommendation is made for this employee until the reviewer answers, because comparing against a guessed role or an incomplete row could flag the wrong access or miss real leftovers.`,
      recommendation: "none (clarification requested)" }];
  }
  const allowed = baseline.get(role);
  const out = [], seen = new Set();
  for (const r of rows) {
    if (!r.system || !r.permission) continue;
    const k = key(r.system, r.permission);
    if (allowed.has(k) || seen.has(k)) continue;
    seen.add(k);
    const prevRule = (baseline.get(emp.previous_role) || new Map()).get(k);
    out.push({ id: `${emp.employee_id}-${out.length + 1}`, type: "flag", employee: effective, system: r.system, permission: r.permission,
      evidence: `Access export row ${r._line}; ${role} baseline rules ${ruleRange(baseline, role)}${prevRule ? `; matches previous-role rule ${prevRule.rule_id}` : "; in no baseline"}`,
      rule: `Not in ${role} baseline`, origin: prevRule ? "previous role" : "no baseline",
      explanation: explainFlag(effective, r, baseline) + (answer ? ` (Role confirmed by reviewer as ${role}.)` : ""),
      recommendation: "reviewer decides" });
  }
  return out;
}

function resolve(result, employeeId, answer) {
  const rows = result._groups.get(employeeId);
  const emp = result.employees.find(e => e.employee_id === employeeId);
  return evaluate(emp, rows, result._baseline, answer);
}

function compact(lines) {
  const s = [...new Set(lines)].sort((a, b) => a - b); const parts = []; let i = 0;
  while (i < s.length) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; parts.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`); i = j + 1; }
  return parts.join(", ");
}

const EXPORT_FIELDS = ["item_id", "item_type", "employee_id", "employee_name", "previous_role", "new_role", "system", "permission",
  "rule", "evidence", "explanation", "decision", "reviewer_note", "reviewer", "decided_at"];

function csvCell(v) { v = v == null ? "" : String(v); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }

function exportRows(items, decisions, reviewer) {
  return items.map(it => {
    const d = decisions[it.id] || {};
    return { item_id: it.id, item_type: it.type, employee_id: it.employee.employee_id, employee_name: it.employee.employee_name,
      previous_role: it.employee.previous_role, new_role: it.employee.new_role || "(unresolved)",
      system: it.system || "(n/a: clarification)", permission: it.permission || "(n/a: clarification)",
      rule: it.rule, evidence: it.evidence, explanation: it.explanation,
      decision: d.decision || "", reviewer_note: d.note || "", reviewer: reviewer || "", decided_at: d.at || "" };
  });
}

function toCSV(rows) {
  return [EXPORT_FIELDS.join(","), ...rows.map(r => EXPORT_FIELDS.map(f => csvCell(r[f])).join(","))].join("\r\n");
}

if (typeof module !== "undefined") module.exports = { parseCSV, analyze, resolve, exportRows, toCSV, EXPORT_FIELDS };
