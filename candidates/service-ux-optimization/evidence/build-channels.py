from pathlib import Path
import shutil,json,hashlib,subprocess
r=Path('/Users/tzz/Documents/itpay-platform-rollout');base=Path('/Users/tzz/Documents/itpay_cli/candidates/service-ux-optimization');cli=base/'source';out=base/'channels';out.mkdir(exist_ok=True)
names=['itpay-plugin-chatgpt','itpay-skill-workbuddy','itpay-skill-openclaw','itpay-plugin-kimi-work','itpay-skill-hermes']
formal=(cli/'skills/itpay/SKILL.md').read_text();body=formal[formal.index('## Choose one entry'):].strip()+'\n';records=[]
for n in names:
 old=r/n;p=out/n
 if p.exists(): shutil.rmtree(p)
 shutil.copytree(old,p,ignore=shutil.ignore_patterns('.git','vendor','node_modules','itpay-cli','.DS_Store'))
 skill=p if n=='itpay-skill-workbuddy' else p/'skills/itpay'
 f=skill/'SKILL.md';text=f.read_text();prefix=text[:text.index('## Choose one entry')]
 suffix=text[text.index('## Built-In Help'):]
 if 'MCP' in prefix:
  prefix=prefix.replace('Use only:\n','The account/Vault tools are:\n').replace('Use only `itpay_account_status`','For account/Vault reads use `itpay_account_status`')
  prefix+='For read-only directory discovery, `itpay_service_list` and `itpay_service_get` are also permitted. They cannot execute services, select candidates, create purchases or refunds.\n\n'
 f.write_text(prefix+body+'\n'+suffix)
 kind='npm-tree' if n=='itpay-plugin-chatgpt' else 'single-file'
 bundle=base/'bundles'/kind
 directory='assets/itpay-cli' if n=='itpay-skill-hermes' else 'vendor/itpay-cli'
 shutil.copytree(bundle/'vendor/itpay-cli',skill/directory,symlinks=True,ignore=shutil.ignore_patterns('licenses') if n=='itpay-skill-workbuddy' else None)
 lock=json.loads((bundle/'bundle.lock.json').read_text());lock['bundleDirectory']=directory;(skill/'bundle.lock.json').write_text(json.dumps(lock,indent=2)+'\n')
 pkg=p/'package.json'
 if pkg.exists():
  d=json.loads(pkg.read_text());d['version']='2.1.36';pkg.write_text(json.dumps(d,indent=2)+'\n')
 for t in (p/'tests').glob('*.mjs'):
  s=t.read_text().replace('/rail-booking --json/','/rail-booking(?: --json)?/');t.write_text(s)
 actual=subprocess.check_output(['node',str(skill/'scripts/itpay.mjs'),'--version'],text=True).strip();assert actual=='2.1.36'
 shown=json.loads(subprocess.check_output(['node',str(skill/'scripts/itpay.mjs'),'skill','show','itpay','--json'],text=True));assert shown['result']['content']==f.read_text()
 docsroot=skill/directory/('package/docs/agent/buyer' if kind=='npm-tree' else 'docs/agent/buyer')
 docs={q.name:hashlib.sha256(q.read_bytes()).hexdigest() for q in (cli/'docs/agent/buyer').glob('*.json')};assert len(docs)==12
 for name,digest in docs.items():assert hashlib.sha256((docsroot/name).read_bytes()).hexdigest()==digest
 guide=json.loads(subprocess.check_output(['node',str(skill/'scripts/itpay.mjs'),'docs','show','rail-booking','--json'],text=True));assert guide['status']=='shown'
 tests=subprocess.run(['node','--test'],cwd=p,text=True,capture_output=True);(p/'candidate-check.log').write_text(tests.stdout+tests.stderr)
 records.append({'channel':n,'path':str(p),'original_source_sha':subprocess.check_output(['git','-C',str(old),'rev-parse','HEAD'],text=True).strip(),'version':actual,'format':lock['format'],'candidate_tarball_sha256':lock['candidateTarballSha256'],'common_business_sha256':hashlib.sha256(body.encode()).hexdigest(),'skill_sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'buyer_docs_sha256':docs,'launcher_skill_show_matches':True,'launcher_rail_guide_shown':True,'existing_tests_exit':tests.returncode,'tests_log':str(p/'candidate-check.log')})
(base/'channel-verification.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
for row in records: print(row['channel'],row['version'],'tests',row['existing_tests_exit'])
