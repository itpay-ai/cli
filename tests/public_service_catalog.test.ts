import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {BackendClient} from '../src/client/backend.js';
import {HttpClient} from '../src/client/http.js';
import {runCatalogList} from '../src/commands/catalog.js';
import type {CatalogManifest} from '../src/client/types.js';

test('parent directory shows modes and dynamic purchase without internal products',async()=>{
 const path=process.env.ITPAY_PUBLICATION_FIXTURE ?? new URL('./fixtures/public-service-boundary.json',import.meta.url);
 const bundle=JSON.parse(readFileSync(path,'utf8'));
 const manifest=bundle.tables.catalog_manifests.find((r:{catalog_manifest_id:string})=>r.catalog_manifest_id===bundle.activate.catalog_manifest_id);
 const backend=new BackendClient(new HttpClient({baseURL:'http://127.0.0.1:1'}));
 backend.getCatalogManifest=async()=>({version:manifest.version,status:'published',item_count:manifest.manifest_json.items.length,manifest:manifest.manifest_json}) satisfies CatalogManifest;
 let json='',text='';await runCatalogList(backend,{jsonOutput:true,output:s=>json+=s});await runCatalogList(backend,{jsonOutput:false,output:s=>text+=s});
 const result=JSON.parse(json);
 assert.equal(result.result.services.filter((s:{service_id:string})=>s.service_id==='itpay-rail').length,1);
 assert.match(text,/火车票服务/);assert.match(text,/query_exact/);assert.match(text,/实时报价/);
 assert.doesNotMatch(text,/itpay-rail-booking|itpay-rail-smart|itpay-rail-exact/);
 let en='';await runCatalogList(backend,{jsonOutput:true,locale:'en',output:s=>en+=s});assert.match(en,/Rail tickets/);
 if(process.env.ITPAY_CATALOG_EVIDENCE)writeFileSync(process.env.ITPAY_CATALOG_EVIDENCE,JSON.stringify({scope:'real renderer with candidate publication; no deployment',text,json:result,english:JSON.parse(en)},null,2));
});

test('formal Skill keeps service orchestration and railway guide owns its business rules',()=>{
 const skill=readFileSync(new URL('../skills/itpay/SKILL.md',import.meta.url),'utf8');
 const rail=readFileSync(new URL('../docs/agent/buyer/rail-booking.json',import.meta.url),'utf8');
 assert.match(skill,/services start itpay-rail/);
 assert.match(skill,/services purchase --input-json/);
 assert.match(skill,/original quote-bound\n?approval protection remains/);
 assert.doesNotMatch(skill,/Fastest means|Raw legs support|seat-request or whole-journey|no-seat option|reuse_from/);
 assert.match(rail,/within the searched scope/);
 assert.match(rail,/no-seat, overnight/);
 assert.match(rail,/complete ordered selections template/);
 assert.match(rail,/reuse an existing explicit human approval/);
});
