"""Build index.html from src/app_template.html, src/engine.js and the sample data. Run from the repo root."""
import json
t = open("src/app_template.html").read()
t = (t.replace("/*ENGINE*/", open("src/engine.js").read())
      .replace("/*SAMPLE_A*/", json.dumps(open("data/access_export.csv").read()))
      .replace("/*SAMPLE_B*/", json.dumps(open("data/role_baseline.csv").read())))
open("index.html", "w").write(t)
print("wrote index.html,", len(t), "bytes")
