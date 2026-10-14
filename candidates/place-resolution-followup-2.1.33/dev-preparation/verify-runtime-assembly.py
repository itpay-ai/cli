#!/usr/bin/env python3
"""Read the prepared images; do not start services or modify an environment."""
import json
import subprocess
import tempfile
from pathlib import Path

images = {"web": "itpay-ng-dev-prepared-web:ad6a2ead", "backend": "itpay-ng-dev-prepared-backend:ad6a2ead"}
for kind, image in images.items():
    container = subprocess.check_output(["docker", "create", image], text=True).strip()
    try:
        with tempfile.TemporaryDirectory(prefix="itpay-assembly-") as directory:
            target = Path(directory)
            if kind == "web":
                subprocess.run(["docker", "cp", container + ":/usr/share/nginx/html/.", str(target)], check=True)
                assert not (target / "apps").exists(), "unbundled source emitted into public assets"
                for path in target.rglob("*"):
                    if path.is_file() and path.suffix in (".js", ".html"):
                        content = path.read_text(errors="ignore")
                        for marker in ("/v1/local-ux/pay", "本地模拟付款入口", "本地体验环境：真实查询"):
                            assert marker not in content, (path.name, marker)
            else:
                for name in ("itpay-v3-backend", "itpay-v3-worker"):
                    path = target / name
                    subprocess.run(["docker", "cp", container + ":/usr/local/bin/" + name, str(path)], check=True)
                    content = path.read_bytes()
                    for marker in (b"/v1/local-ux/pay", b"localux-desktop-buyer", b"localux_rail_"):
                        assert marker not in content, (name, marker)
            print(json.dumps({"image": image, "assembly": "no local simulation"}))
    finally:
        subprocess.run(["docker", "rm", container], check=True, stdout=subprocess.DEVNULL)
