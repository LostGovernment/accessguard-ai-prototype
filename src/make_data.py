"""Generate the synthetic AccessGuard AI test set with a known answer key.
All people, roles and permissions are invented. No real employee data."""
import csv, json, random

random.seed(524)

# ---------- role baselines ----------
COMMON = [("Microsoft 365", "Standard User"), ("Slack", "Member"), ("SharePoint", "Company Intranet Read")]
ROLES = {
    "Finance Analyst": ("FA", [("NetSuite", "GL Read"), ("NetSuite", "Journal Entry Create"),
                                ("Workday", "Expense Report Review"), ("Tableau", "Finance Dashboards Viewer"),
                                ("SharePoint", "Finance Site Edit")]),
    "Accounts Payable Specialist": ("AP", [("NetSuite", "Vendor Bill Create"), ("NetSuite", "GL Read"),
                                           ("Bill.com", "Payment Prepare"), ("SharePoint", "Finance Site Edit")]),
    "Sales Representative": ("SR", [("Salesforce", "Opportunity Edit"), ("Salesforce", "Account Read"),
                                     ("HubSpot", "Contacts Edit"), ("Gong", "Call Recording User")]),
    "Sales Operations Analyst": ("SO", [("Salesforce", "Report Builder"), ("Salesforce", "Account Read"),
                                         ("Tableau", "Sales Dashboards Editor"), ("HubSpot", "Contacts Read")]),
    "HR Generalist": ("HR", [("Workday", "Employee Record Edit"), ("Workday", "Compensation Read"),
                              ("Greenhouse", "Recruiter"), ("SharePoint", "HR Site Edit")]),
    "Software Engineer": ("SE", [("GitHub", "Repository Write"), ("AWS", "Dev Account PowerUser"),
                                  ("Jira", "Developer"), ("Datadog", "Read Only")]),
    "Site Reliability Engineer": ("RE", [("AWS", "Prod Account Operator"), ("GitHub", "Repository Write"),
                                          ("PagerDuty", "Responder"), ("Datadog", "Admin"), ("Jira", "Developer")]),
    "Data Analyst": ("DA", [("Snowflake", "Analytics Reader"), ("Tableau", "Creator"),
                             ("Jira", "Reporter"), ("GitHub", "Repository Read")]),
    "Customer Support Agent": ("CS", [("Zendesk", "Agent"), ("Salesforce", "Account Read"),
                                       ("Jira", "Reporter")]),
    "Marketing Specialist": ("MK", [("HubSpot", "Marketing Hub Editor"), ("Canva", "Team Member"),
                                     ("SharePoint", "Marketing Site Edit"), ("Google Analytics", "Viewer")]),
}

baseline = []
for role, (code, perms) in ROLES.items():
    for i, (sysn, perm) in enumerate(COMMON + perms, 1):
        baseline.append({"role": role, "system": sysn, "permission": perm, "rule_id": f"{code}-{i:02d}"})

def perms_of(role):
    return COMMON + ROLES[role][1]

# Exception grants that are in no baseline at all
EXCEPTIONS = [("AWS", "Billing Console Admin"), ("Salesforce", "Export All Data"),
              ("Workday", "Payroll Admin"), ("GitHub", "Organization Owner"), ("Snowflake", "ACCOUNTADMIN")]

FIRST = ["Avery", "Jordan", "Priya", "Marcus", "Lena", "Tomas", "Keiko", "Omar", "Grace", "Diego",
         "Hana", "Samuel", "Nadia", "Victor", "Imani", "Felix", "Rosa", "Kenji", "Leah", "Andre",
         "Mei", "Caleb", "Sofia", "Ravi", "Elena", "Jonah", "Amara", "Theo", "Yuki", "Isaac", "Noor", "Paul"]
LAST = ["Holt", "Reyes", "Nair", "Okafor", "Lindqvist", "Brandt", "Sato", "Haddad", "Whitfield", "Morales",
        "Cho", "Adeyemi", "Petrov", "Alvarez", "Mensah", "Koenig", "Duarte", "Mori", "Fischer", "Baptiste",
        "Lin", "Porter", "Romano", "Iyer", "Vasquez", "Kline", "Obi", "Marsh", "Tanaka", "Grant", "Rahman", "Ellison"]

roles = list(ROLES)
access, key = [], []
emp_no = 1040

def add_rows(eid, name, prev, new, date, perm_list):
    for sysn, perm in perm_list:
        access.append({"employee_id": eid, "employee_name": name, "previous_role": prev,
                       "new_role": new, "change_date": date, "system": sysn, "permission": perm})

# Scenario plan: 30 employees
# 22 normal with leftovers, 3 clean, 2 missing new_role, 2 conflicting new_role, 1 unknown role,
# plus one normal employee gets a row with a blank permission (missing field)
plan = (["normal"] * 22) + (["clean"] * 3) + (["missing_role"] * 2) + (["conflict"] * 2) + ["unknown_role"]
random.shuffle(plan)
blank_perm_target = None

for idx, kind in enumerate(plan):
    emp_no += random.randint(3, 17)
    eid = f"E{emp_no}"
    name = f"{FIRST[idx]} {LAST[idx]}"
    prev, new = random.sample(roles, 2)
    date = f"2026-{random.choice(['09', '10'])}-{random.randint(1, 28):02d}"
    new_perms = perms_of(new)
    prev_only = [p for p in perms_of(prev) if p not in new_perms]
    entry = {"employee_id": eid, "employee_name": name, "scenario": kind}

    if kind == "clean":
        add_rows(eid, name, prev, new, date, new_perms)
        entry.update(expected="no_flags", expected_flags=[])
    elif kind == "normal":
        k = min(len(prev_only), random.randint(1, 3))
        left = random.sample(prev_only, k)
        extra = [random.choice(EXCEPTIONS)] if random.random() < 0.25 else []
        add_rows(eid, name, prev, new, date, new_perms + left + extra)
        entry.update(expected="flags", expected_flags=sorted(f"{s}|{p}" for s, p in left + extra))
        if blank_perm_target is None:
            blank_perm_target = eid
            access.append({"employee_id": eid, "employee_name": name, "previous_role": prev,
                           "new_role": new, "change_date": date, "system": "Jira", "permission": ""})
            entry.update(expected="clarify", reason="missing_permission_value",
                         note="One row has a blank permission; flags are held until the reviewer confirms the row.")
    elif kind == "missing_role":
        left = random.sample(prev_only, min(2, len(prev_only)))
        add_rows(eid, name, prev, "", date, new_perms + left)
        entry.update(expected="clarify", reason="missing_new_role", expected_flags_after_answer=sorted(f"{s}|{p}" for s, p in left), true_new_role=new)
    elif kind == "conflict":
        other = random.choice([r for r in roles if r not in (prev, new)])
        rows_before = len(access)
        add_rows(eid, name, prev, new, date, new_perms + random.sample(prev_only, min(2, len(prev_only))))
        # make the last two rows disagree on the new role
        for r in access[-2:]:
            r["new_role"] = other
        entry.update(expected="clarify", reason="conflicting_new_role", roles_seen=sorted({new, other}))
    elif kind == "unknown_role":
        add_rows(eid, name, prev, "Product Manager", date,
                 COMMON + [("Jira", "Project Admin"), ("Salesforce", "Account Read")] + prev_only[:2])
        entry.update(expected="clarify", reason="no_baseline_for_role", new_role="Product Manager")
    key.append(entry)

random.shuffle(access)
access.sort(key=lambda r: r["employee_id"])  # grouped by employee, like a real export

with open("data/access_export.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(access[0]))
    w.writeheader(); w.writerows(access)
with open("data/role_baseline.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(baseline[0]))
    w.writeheader(); w.writerows(baseline)
with open("data/answer_key.json", "w") as f:
    json.dump(key, f, indent=1)

n_flags = sum(len(e.get("expected_flags", [])) for e in key if e["expected"] == "flags")
print(len(access), "access rows;", len(baseline), "baseline rules;", len(key), "employees")
print("planted mismatches:", n_flags, "| clarify cases:", sum(e["expected"] == "clarify" for e in key))
