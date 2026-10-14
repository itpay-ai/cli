from pathlib import Path
import json,subprocess,shutil,tempfile,hashlib
base=Path('/Users/tzz/Documents/itpay_cli/candidates/aftercare-manual-handoff');records=json.loads((base/'channel-verification.json').read_text())
for row in records:
 name=row['channel'];root=Path(row['path']);artifact=base/'artifacts'/f'{name}-2.1.38-candidate.zip';archive=base/'artifacts/previous'/artifact.name
 if artifact.exists() and not archive.exists():shutil.copy2(artifact,archive)
 if name=='itpay-plugin-chatgpt':cwd=root;members=['.codex-plugin','skills','assets','LICENSE']
 elif name=='itpay-skill-workbuddy':cwd=root;members=['SKILL.md','agents','scripts','vendor','bundle.lock.json']
 elif name=='itpay-plugin-kimi-work':cwd=root;members=['kimi.plugin.json','skills','LICENSE']
 else:cwd=root/'skills/itpay';members=['SKILL.md','agents','scripts','assets' if name=='itpay-skill-hermes' else 'vendor','bundle.lock.json']
 members=[m for m in members if (cwd/m).exists()]
 with tempfile.TemporaryDirectory(prefix='itpay-rework-zip-') as temp:
  z=Path(temp)/artifact.name;subprocess.run(['zip','-q','-yr',str(z),*members],cwd=cwd,check=True);shutil.copy2(z,artifact)
  extracted=Path(temp)/'extracted';extracted.mkdir();subprocess.run(['unzip','-q',str(z),'-d',str(extracted)],check=True)
  skill=extracted/'skills/itpay' if name in ['itpay-plugin-chatgpt','itpay-plugin-kimi-work'] else extracted
  version=subprocess.check_output(['node',str(skill/'scripts/itpay.mjs'),'--version'],text=True).strip();assert version=='2.1.38'
  guide=json.loads(subprocess.check_output(['node',str(skill/'scripts/itpay.mjs'),'docs','show','rail-booking','--json'],text=True));assert guide['status']=='shown'
 row.update(zip_path=str(artifact),zip_sha256=hashlib.sha256(artifact.read_bytes()).hexdigest(),zip_launcher_version=version,zip_rail_guide_shown=True)
(base/'channel-verification.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n');print([(r['channel'],r['zip_sha256'])for r in records])
