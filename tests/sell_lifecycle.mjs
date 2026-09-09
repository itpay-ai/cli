// Real Go handlers + isolated Postgres. Identity and Provider network routing are
// injected by the test harness; no production backend or credentials are used.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [url,dir,providerURL]=process.argv.slice(2),project=join(dir,'project');
const env={...process.env,HOME:dir,NODE_ENV:'test',ITPAY_BACKEND_URL:'https://sandbox.itpay.ai',ITPAY_CLI_TEST_TRANSPORT_URL:url,SELL_TEST_KEY:'fixture-only'};
let serial=0;const evidence=[];
const mcpClients = new Map();
async function mcpCall(command, options, input, actor) {
 if (!mcpClients.has(actor)) {
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client=new Client({name:'sell-acceptance',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:join(root,'node_modules/.bin/tsx'),args:[join(root,'tests/sell_integration_entry.ts'),'sell','mcp','--stdio','--project',project],cwd:root,env:{...env,ITPAY_SELL_TEST_ACTOR:actor},stderr:'pipe'}));
  const inventory=await client.listTools();assert.equal(inventory.tools.length,52);
  mcpClients.set(actor,client);
 }
 const args={input:input??{}};
 for(let i=0;i<options.length;i++) {const flag=options[i];if(flag==='--confirm'){args.confirmed=true;continue;} const value=options[++i];if(flag==='--project')continue;args[flag.slice(2).replaceAll('-','_')]=value;}
 const localCommands=['init','config','workflow import','sources add','credentials bind','credentials upload','workflow validate','workflow confirm','workflow versions save','workflow versions list','workflow versions use','workflow versions delete','test run','test resume','test get'];
 let name='itpay_seller_platform_'+command.replaceAll(' ','_').replaceAll('-','_');
 if(localCommands.includes(command)){name='itpay_seller_local_'+command.replaceAll(' ','_');if(args.version_id){args.version=args.version_id;delete args.version_id;}delete args.input;}
 if(command==='guide'&&!args.merchant_id){name='itpay_seller_guide';delete args.input;}
 if(command==='push'||command==='pull'){name='itpay_seller_sync';args.action=command;args.bindings_file=args.bindings;delete args.bindings;delete args.input;}
 const result=await mcpClients.get(actor).callTool({name,arguments:args});
 if(result.isError){const error=new Error(JSON.stringify(result));error.code=1;throw error;}
 return JSON.parse(result.content.find(item=>item.type==='text').text);
}

function file(value,name=`input-${serial++}.json`){const path=join(dir,name);writeFileSync(path,typeof value==='string'?value:JSON.stringify(value));return path;}
async function cli(command,options=[],input,expected='ok',actor='seller'){
 const args=['sell',...command.split(' '),...options,'--json'];if(input!==undefined)args.push('--input-json',file(input));
 try{if(process.env.SELL_ACCEPTANCE_TRANSPORT==='mcp' && command!=='submission watch'){const data=await mcpCall(command,options,input,actor);assert.notEqual(expected,'error',`${command} unexpectedly succeeded`);evidence.push({command,case:expected,status:'passed',transport:'stdio MCP'});console.log('PASS MCP',command,expected);return data;} const {stdout}=await exec(join(root,'node_modules/.bin/tsx'),[join(root,'tests/sell_integration_entry.ts'),...args],{cwd:root,env:{...env,ITPAY_SELL_TEST_ACTOR:actor},timeout:30000,maxBuffer:4*1024*1024});
 const data=JSON.parse(stdout);assert.notEqual(expected,'error',`${command} unexpectedly succeeded`);assert.notEqual(data.status,'error',JSON.stringify(data));evidence.push({command,case:expected,status:'passed'});console.log('PASS',command,expected);return data.result??data;
 }catch(error){if(expected==='error' && typeof error.code === 'number'){evidence.push({command,case:'expected rejection',status:'passed'});console.log('PASS',command,'rejected');return;};throw new Error(`${command}: ${error.stdout??''} ${error.stderr??error.message}`);}
}
const local=['--project',project],org=['--merchant-id','sell_merchant'];
await cli('guide');await cli('status');await cli('init',[...local,'--service-id','sell-integration','--name','Integration']);
await cli('config',[...local,'--file',file({pricing:{billing_mode:'per_call',amount_minor:100,currency:'CNY'},policy:{},fixtures:[{fixture_id:'normal',name:'Normal',input:{query:'hello'},expected_outcome:'success'}]})]);
const paths={};
for (const name of ['first','second','third']) {
 const operation={"parameters": [{"name": "query", "in": "query", "required": true, "schema": {"type": "string"}}], "responses": {"200": {"description": "OK", "content": {"application/json": {"schema": {"type": "object", "required": ["value"], "properties": {"value": {"type": "string"}}}}}}}};
operation.operationId=name;paths['/'+name]={get:operation};
}

const source={openapi:'3.0.3',info:{title:'Isolated',version:'1.0.0'},servers:[{url:'https://provider.test.invalid'}],paths};
assert.equal((await fetch(url+'/__test/library',{method:'POST',body:JSON.stringify(source)})).status,201);
await cli('library search',[],{q:'Test'});await cli('library get',['--library-api-id','lap_test']);await cli('sources library',org,{library_api_id:'lap_test'});
const compiled=await cli('sources add',[...local,'--file',file(source),'--provider-key','sell.test']);
await cli('credentials bind',[...local,'--profile','local-profile','--file',file({api_key:'SELL_TEST_KEY'})]);
const profile=await cli('credentials upload',[...local,...org,'--profile','local-profile','--provider-key','sell.test','--confirm']);

await cli('credentials status',org);
let yaml=readFileSync(join(dir,'template.yaml'),'utf8').replaceAll('PROFILE','local-profile');
for(const operation of compiled.operations)yaml=yaml.replaceAll('OP_'+operation.operation_key,operation.provider_operation_version_id);
await cli('workflow import',[...local,'--file',file(yaml,'workflow.yaml')]);
const validation=await cli('workflow validate',local);assert.equal(validation.result.valid,true,JSON.stringify(validation));
const version=await cli('workflow versions save',[...local,'--name','First']);await cli('workflow versions list',local);await cli('workflow versions use',[...local,'--version-id',version.version_id]);
// Test-only upstream routing, matching the cloud harness; never alter method,
// content type, parameter mappings or response schemas.
const originals=[];
for (const name of readdirSync(join(project,'.itpay-sell','sources'))) {
 const path=join(project,'.itpay-sell','sources',name), raw=readFileSync(path,'utf8');originals.push([path,raw]);const value=JSON.parse(raw);
 for (const op of value.operations) {op.operation.base_url=providerURL;op.operation.allow_insecure_test_http=true;}
 writeFileSync(path,JSON.stringify(value));
}
const localRun=await cli('test run',[...local,'--confirm']);assert.equal(localRun.report.status,'passed',JSON.stringify(localRun));
await cli('test get',[...local,'--run',localRun.run_id]);
const resumed=await cli('test resume',[...local,'--run',localRun.run_id,'--confirm']);assert.equal(resumed.report.status,'passed');
for (const [path,raw] of originals) writeFileSync(path,raw);
await cli('workflow confirm',local);await cli('workflow confirm',[...local,'--confirm']);
const bindings=file({'local-profile':profile.credential_profile_id});
let uploaded=await cli('push',[...local,...org,'--bindings',bindings,'--confirm']);
await cli('config',[...local,'--file',file({public_name:'Integration revised'})]);
await cli('workflow versions save',[...local,'--name','Revised']);await cli('workflow confirm',[...local,'--confirm']);
await fetch(url+'/__test/fault',{method:'POST',body:JSON.stringify({Mode:1})});
await cli('push',[...local,...org,'--bindings',bindings,'--confirm'],undefined,'error');
uploaded=await cli('push',[...local,...org,'--bindings',bindings,'--confirm']);
await cli('config',[...local,'--file',file({public_name:'Integration final'})]);
await cli('workflow versions save',[...local,'--name','Final']);await cli('workflow confirm',[...local,'--confirm']);
await fetch(url+'/__test/fault',{method:'POST',body:JSON.stringify({Mode:2})});
await cli('push',[...local,...org,'--bindings',bindings,'--confirm'],undefined,'error');
await cli('push',[...local,...org,'--bindings',bindings,'--confirm'],undefined,'error');
await cli('pull',[...local,...org,'--draft-id',uploaded.cloud.draft_id,'--confirm']);
await cli('workflow versions save',[...local,'--name','Reconciled']);await cli('workflow confirm',[...local,'--confirm']);
uploaded=await cli('push',[...local,...org,'--bindings',bindings,'--confirm']);
const cloud=uploaded.cloud,draft=[...org,'--draft-id',cloud.draft_id];
await cli('push',[...local,...org,'--bindings',bindings,'--confirm']);
await cli('services icon',draft,{content_base64:readFileSync(join(dir,'icon.png')).toString('base64')});
await cli('services create',org,{service_id:'disposable-service',public_name:'Disposable'});
await cli('services list',org);await cli('services get',draft);await cli('workflow catalog',org);await cli('guide',org,{draft_id:cloud.draft_id});
await cli('services get',draft,undefined,'error','other');
await cli('workflow upload',draft,{expected_revision:0,arazzo:{}},'error');
await cli('sources list',org);const imports=await cli('sources import',org,{provider_key:'sell.test',document:source});
await cli('sources inspect',[...org,'--intake-id',imports.api_intake_id]);
await cli('sources probe',[...org,'--intake-id',imports.api_intake_id,'--confirm'],{credential_profile_id:profile.credential_profile_id,operation_inputs:Object.fromEntries(imports.operations.map(op=>[op.provider_operation_version_id,{query:{query:'hello'}}]))});
const fixtureState=await cli('fixtures get',draft); const savedFixtures=await cli('fixtures set',draft,{expected_revision:fixtureState.revision,fixtures:fixtureState.fixtures});cloud.fixture_revision=savedFixtures.revision;
const settings=await cli('pricing get',draft);const repriced=await cli('pricing set',draft,{expected_revision:cloud.revision,pricing:settings.pricing,policy:settings.policy});cloud.revision=repriced.semantic_revision;
console.log('STATIC',JSON.stringify(await cli('workflow validate-platform',draft)));
await cli('workflow versions list-platform',draft);
const copy=await cli('workflow versions save-platform',draft,{name:'Disposable',source:'current',arazzo_document:(await cli('services get',draft)).arazzo.arazzo_document,expected_revision:cloud.revision});
await cli('workflow versions delete-platform',[...draft,'--version-id',copy.version_id,'--confirm'],{expected_revision:cloud.revision});
let run=await cli('verify',[...draft,'--confirm'],{workflow_version_id:cloud.version_id,expected_semantic_revision:cloud.revision,expected_fixture_revision:cloud.fixture_revision});
const runID=run.validation_run_id;run=await cli('runs get',[...draft,'--run-id',runID]);console.log('RUN',run.status,JSON.stringify(run.issues));
if(run.status==='awaiting_confirmation'||run.status==='requires_confirmation'){await cli('runs confirm',[...draft,'--run-id',runID,'--confirm'],{risk_hash:run.risk_hash});run=await cli('runs get',[...draft,'--run-id',runID]);}
assert.equal(run.status,'passed',JSON.stringify(run));
const preview=await cli('submission preview',org,{draft_id:cloud.draft_id});assert.equal(preview.stage,'submission_preview',JSON.stringify(preview));
await cli('submission submit',[...draft,'--confirm'],{expected_revision:cloud.revision,terms_version:'invalid',confirmations:[]},'error');
let submitted=await cli('submission submit',[...draft,'--confirm'],{expected_revision:cloud.revision,terms_version:preview.terms_version,confirmations:preview.required_confirmations});
await cli('submission get',[...org,'--submission-id',submitted.submission_id]);
await cli('submission get',[...org,'--submission-id',submitted.submission_id],undefined,'error','other');
await cli('submission withdraw',[...org,'--submission-id',submitted.submission_id,'--confirm']);
submitted=await cli('submission submit',[...draft,'--confirm'],{expected_revision:cloud.revision,terms_version:preview.terms_version,confirmations:preview.required_confirmations});
const response=await fetch(url+'/__test/approve',{method:'POST',body:JSON.stringify({id:submitted.submission_id})});assert.equal(response.status,200,await response.clone().text());
const approved=await cli('submission get',[...org,'--submission-id',submitted.submission_id]);assert.equal(approved.status,'published');
await cli('submission watch',[...org,'--submission-id',submitted.submission_id,'--timeout','0']);
await cli('pull',[...local,...draft,'--confirm']);
const catalog=await exec(join(root,'node_modules/.bin/tsx'),[join(root,'tests/sell_integration_entry.ts'),'catalog','list','--json'],{cwd:root,env,timeout:30000});
assert(JSON.parse(catalog.stdout).result.services.some(service=>service.service_id==='sell-integration'),catalog.stdout);
evidence.push({command:'catalog list',case:'newly approved service is discoverable',status:'passed'});
await cli('workflow versions delete',[...local,'--version-id',version.version_id,'--confirm']);
await cli('test get',[...local,'--run',localRun.run_id],undefined,'error');
for(const client of mcpClients.values()) await client.close();
writeFileSync(join(dir,'command-evidence.json'),JSON.stringify(evidence,null,2));console.log('LIFECYCLE PASSED',evidence.length);
