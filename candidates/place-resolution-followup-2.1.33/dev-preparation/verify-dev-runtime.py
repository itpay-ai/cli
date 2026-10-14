import json, subprocess, hashlib, urllib.request
from pathlib import Path
expected = "45175400703c8ecaf846a000678866fac00b4634"
root = Path("/Users/tzz/Documents/itpay_cli/candidates/place-resolution-followup-2.1.33/dev-preparation/rebuild-checkout")
remote = r"""
import json, subprocess, hashlib
from pathlib import Path
out = {"containers": {}, "planner_sources": {}}
for service in ("backend", "backend-worker", "rail-planner", "web", "mcp", "db"):
    name = "itpay-v3-next-" + service + "-1"
    row = json.loads(subprocess.check_output(["docker", "inspect", name]))[0]
    env = dict(item.split("=", 1) for item in row["Config"].get("Env", []) if "=" in item)
    out["containers"][service] = {"image_id": row["Image"], "image": row["Config"]["Image"], "status": row["State"]["Status"], "health": row["State"].get("Health", {}).get("Status"), "restart_count": row["RestartCount"], "started_at": row["State"]["StartedAt"], "local_ux_env_names": [key for key in env if key.startswith("ITPAY_LOCAL_UX") or key == "GOFLAGS"], "version": env.get("ITPAY_VERSION"), "provider_mode": env.get("V3_SERVICE_PROVIDER_MODE")}
for path in sorted(Path("/home/ubuntu/compose/services/rail-planner").glob("*.py")):
    out["planner_sources"][path.name] = subprocess.check_output(["docker", "exec", "itpay-v3-next-rail-planner-1", "sha256sum", "/app/" + path.name], text=True).split()[0]
query = "SELECT row_to_json(r) FROM (SELECT platform_release_id, platform_revision, publication_revision, publication_checksum, schema_revision, schema_set_hash, minimum_cli_version, (SELECT count(*) FROM platform_releases WHERE status='active') AS active_count FROM platform_releases WHERE status='active') r;"
out["active_release"] = json.loads(subprocess.check_output(["docker", "exec", "itpay-v3-next-db-1", "psql", "-U", "itpay", "-d", "itpay_v3", "-X", "-qAt", "-c", query], text=True))
query = "SELECT service_contract_publication_id FROM service_contract_publications WHERE status='active' AND service_contract_publication_id IN ('scp_itpay_rail_booking_v4','scp_itpay_rail_smart_v6','scp_itpay_rail_exact_v1') ORDER BY service_contract_publication_id;"
out["active_contract_publications"] = subprocess.check_output(["docker", "exec", "itpay-v3-next-db-1", "psql", "-U", "itpay", "-d", "itpay_v3", "-X", "-qAt", "-c", query], text=True).splitlines()
for binary in ("itpay-v3-backend", "itpay-v3-worker"):
    subprocess.run(["docker", "exec", "itpay-v3-next-backend-1", "sh", "-ec", "! grep -a -q -E '/v1/local-ux/pay|localux-desktop-buyer|localux_rail_' /usr/local/bin/" + binary], check=True)
subprocess.run(["docker", "exec", "itpay-v3-next-web-1", "sh", "-ec", "test ! -d /usr/share/nginx/html/apps && ! grep -R -q -E '/v1/local-ux/pay|本地模拟付款入口|本地体验环境：真实查询' /usr/share/nginx/html/assets"], check=True)
out["normal_assembly"] = "no local simulation in runtime binaries or web assets"
print(json.dumps(out))
"""
raw = subprocess.check_output(["ssh", "-i", "/Users/tzz/Documents/keys/tencent_cloud_v1.pem", "-o", "IdentitiesOnly=yes", "ubuntu@43.134.240.254", "python3 -"], input=remote.encode())
out = json.loads(raw)
for path, checksum in out["planner_sources"].items():
    assert hashlib.sha256((root / "services/rail-planner" / path).read_bytes()).hexdigest() == checksum, path
out["planner_sources_match_merge"] = True
for endpoint in ("readyz", "platform/compatibility", "catalog/manifest"):
    out[endpoint] = json.load(urllib.request.urlopen("https://dev.itpay.ai/v1/" + endpoint, timeout=30))
assert out["readyz"]["version"] == expected, out["readyz"]
assert out["active_release"]["platform_release_id"] == "platform_v3_20261002_1"
assert out["active_release"]["active_count"] == 1
assert out["active_release"]["minimum_cli_version"] == "2.1.33"
assert len(out["active_contract_publications"]) == 3
for name, row in out["containers"].items():
    assert row["status"] == "running", name
    assert row["health"] in (None, "healthy"), (name, row["health"])
    assert not row["local_ux_env_names"], name
out["expected_merge_sha"] = expected
print(json.dumps(out, indent=2, ensure_ascii=False))
