import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileV2 } from '../src/profile-v2.mjs';
import { defaultPromptValues, promptContextForProvider } from '../src/prompt-context.mjs';
import { createMediaAssetStore, createMemoryMediaDatabase } from '../src/media-asset-store.mjs';
import { createVisualStorage, STORAGE_KEYS } from '../src/visual-workbench/storage.mjs';
import { createDemo } from '../src/visual-workbench/model.mjs';
import {
  defaultProviderEndpoint, createVisualProvider, emptyAuthoringSession, sessionWithTextDraft,
  editTextSession, chooseTextTitle, confirmTextSession, generateTextDraft, readProviderHealth, runImageGeneration,
} from '../src/visual-workbench/creator.mjs';

function textDraft() {
  return {
    schema: 'xiaoshimei.text-draft-response.v1', draft_id: 'draft-text-1', source_input: '为什么真正会休息的人，工作反而更快？',
    text_requirements: '', pillar: 'wellness', goal: 'save',
    titles: ['真正会休息的人工作更快', '休息不是偷懒而是恢复能力', '把休息变成你的工作能力'],
    selected_title: '真正会休息的人工作更快', body: '休息不是停摆。'.repeat(45),
    tags: ['休息', '效率', '成长', '工作', '生活'], recommended_image_count: 3,
    facts: [], risks: [], content_type: 'knowledge_card', style_lock: null,
    prompt_context: promptContextForProvider(defaultPromptValues()),
  };
}
test('provider endpoint keeps local loopback and production same-origin contracts', () => {
  assert.equal(defaultProviderEndpoint({ hostname: '127.0.0.1', origin: 'http://127.0.0.1:4197' }), 'http://127.0.0.1:4175/generate');
  assert.equal(defaultProviderEndpoint({ hostname: 'xiaoshimei-full-workbench.vercel.app', origin: 'https://xiaoshimei-full-workbench.vercel.app' }), 'https://xiaoshimei-full-workbench.vercel.app/api/provider/generate');
});

test('text generation uses text endpoint and causes zero image calls before explicit image action', async () => {
  const calls=[];
  const fetchImpl=async (url, options={}) => {
    calls.push({url:String(url),method:options.method||'GET',body:options.body||null});
    if(String(url).endsWith('/text-draft')) return new Response(JSON.stringify(textDraft()),{status:200,headers:{'content-type':'application/json'}});
    throw new Error('UNEXPECTED_ENDPOINT:'+url);
  };
  const provider=createVisualProvider({endpoint:'http://127.0.0.1:4175/generate',fetchImpl});
  const draft=await generateTextDraft({provider,profile:createProfileV2(),topic:'为什么真正会休息的人工作更快？'});
  assert.equal(draft.selected_title,'真正会休息的人工作更快');
  assert.equal(calls.filter(x=>x.url.includes('generate-images')).length,0);
  assert.equal(calls.length,1);
  assert.ok(calls[0].url.endsWith('/text-draft'));
});
test('text session edits invalidate confirmation and confirmation requires valid draft', () => {
  let session=sessionWithTextDraft(emptyAuthoringSession({topic:'原题'}),textDraft());
  session=confirmTextSession(session); assert.equal(session.text_confirmed,true);
  session=editTextSession(session,'tag','新标签',0); assert.equal(session.text_confirmed,false); assert.equal(session.text_draft.tags[0],'新标签');
  session=chooseTextTitle(session,session.text_draft.titles[1]); assert.equal(session.text_draft.selected_title,session.text_draft.titles[1]);
  assert.equal(confirmTextSession(session).text_confirmed,true);
});

function memoryStorage(){const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),data};}
function storageAdapter(storage){return createVisualStorage({storage,mediaStore:createMediaAssetStore({database:createMemoryMediaDatabase()}),lockManager:{request:async(_name,_options,callback)=>callback()}});}

test('generation session is persisted in the same v3 DraftRecord and reloads with content',async()=>{
  const storage=memoryStorage(),a=storageAdapter(storage);await a.load();
  const session=confirmTextSession(sessionWithTextDraft(emptyAuthoringSession({topic:'同稿测试'}),textDraft()));
  await a.save(createDemo(),{generationSession:session});
  const raw=JSON.parse(storage.getItem(STORAGE_KEYS.envelopeV3));
  const record=raw.drafts.find(d=>d.draft_id===raw.active_draft_id);
  assert.equal(record.generation_session.text_draft.draft_id,'draft-text-1');assert.equal(record.generation_session.text_confirmed,true);
  const b=storageAdapter(storage);await b.load();assert.equal(b.session().text_draft.selected_title,'真正会休息的人工作更快');
});

test('provider health failure remains explicit and cannot look configured',async()=>{
  const state=await readProviderHealth({checkHealth:async()=>{throw new Error('network down');}});
  assert.equal(state.status,'OFFLINE');assert.equal(state.configured,false);assert.match(state.error,/network down/);
});

function readyImageResponse(status='READY') {
  return {
    status, run_id:'run-mock-1', checkpoint_preimage:{ cursor:0 }, checkpoint_preimage_sha256:'a'.repeat(64),
    logical_step_id:'plan-1', assets:[], media_delta:[],
    progress:{completed_image_steps:0,total_image_steps:3,max_image_calls:6,actual_image_calls:0,remaining_image_calls:6},
  };
}

async function confirmedService() {
  const storage=memoryStorage(),service=storageAdapter(storage);await service.load();
  const session=confirmTextSession(sessionWithTextDraft(emptyAuthoringSession({topic:'同稿配图'}),textDraft()));
  await service.save(createDemo(),{generationSession:session});
  return {service,session,storage};
}

test('image bootstrap is committed before provider sees START and discovery can stop after durable checkpoint',async()=>{
  const {service,session}=await confirmedService();let providerCalls=0;
  const provider={
    fetchImageMediaDelta:async()=>[],
    generateImages:async(input,onProgress)=>{
      providerCalls++;assert.equal(input.mode,'START');assert.ok(service.pending(),'pending checkpoint must exist before provider call');
      const decision=await onProgress(readyImageResponse());assert.equal(decision.action,'STOP');assert.equal(decision.checkpointPersisted,true);return readyImageResponse();
    },
  };
  const result=await runImageGeneration({provider,service,session,discoveryOnly:true});
  assert.equal(result.status,'READY');assert.equal(providerCalls,1);assert.equal(service.pending().protocol_state,'READY');
  assert.equal(service.session().image_resume.resume_run_id,'run-mock-1');
});
test('next paid STEP is proposed only after READY checkpoint readback',async()=>{
  const {service,session}=await confirmedService();let observedDecision=null;
  const provider={
    fetchImageMediaDelta:async()=>[],
    generateImages:async(input,onProgress)=>{
      assert.equal(input.mode,'START');observedDecision=await onProgress(readyImageResponse());
      assert.equal(service.pending().protocol_state,'READY','checkpoint must be durable before STEP is returned');
      assert.equal(observedDecision.action,'CONTINUE');assert.equal(observedDecision.request.mode,'STEP');
      const stop=new Error('TEST_STOP_AFTER_DURABLE_CHECKPOINT');stop.intentionalStop=true;stop.checkpointPersisted=true;throw stop;
    },
  };
  const result=await runImageGeneration({provider,service,session,discoveryOnly:false});
  assert.equal(result.status,'CHECKPOINTED');assert.deepEqual(result.request_modes,['START','STEP']);
  assert.ok(service.pending());
});

test('inactive pending draft stays discoverable and reopening it is zero-provider',async()=>{
  const storage=memoryStorage(),service=storageAdapter(storage);await service.load();
  const sessionA=confirmTextSession(sessionWithTextDraft(emptyAuthoringSession({topic:'恢复稿A'}),textDraft()));
  await service.save(createDemo(),{generationSession:sessionA});const draftA=service.activeRecord().draft_id;
  await service.save(createDemo(),{asNew:true,generationSession:null});const draftB=service.activeRecord().draft_id;
  await service.activateDraft(draftA);let providerCalls=0;
  const provider={fetchImageMediaDelta:async()=>[],generateImages:async(input,onProgress)=>{providerCalls++;assert.equal(input.mode,'START');const response=readyImageResponse();const decision=await onProgress(response);assert.equal(decision.action,'STOP');return response;}};
  await runImageGeneration({provider,service,session:service.session(),discoveryOnly:true});
  assert.equal(service.pending().protocol_state,'READY');
  await service.activateDraft(draftB);const recoveries=service.recoveryDrafts();
  assert.equal(recoveries.length,1);assert.equal(recoveries[0].draft_id,draftA);assert.equal(recoveries[0].protocol_state,'READY');
  const callsBeforeOpen=providerCalls;await service.activateDraft(draftA);
  assert.equal(providerCalls,callsBeforeOpen);assert.equal(service.pending().protocol_state,'READY');
});


test('Sprint 2 source input and references stay in one authoring record',async()=>{
 const api=await import('../src/visual-workbench/creator.mjs');
 assert.equal(typeof api.updateAuthoringInput,'function');assert.equal(typeof api.updateActionReferences,'function');
 const initial=emptyAuthoringSession();const changed=api.updateAuthoringInput(initial,{topic:'A complete topic',textRequirements:'Keep the source facts'});
 const referenced=api.updateActionReferences(changed,{note:'Use pose only'});
 const storage=memoryStorage(),a=storageAdapter(storage);await a.load();await a.save(createDemo(),{generationSession:referenced});const b=storageAdapter(storage);await b.load();
 assert.equal(b.session().topic,'A complete topic');assert.equal(b.session().text_requirements,'Keep the source facts');assert.equal(b.session().action_reference_note,'Use pose only');
 assert.equal(b.session().text_confirmed,false);a.dispose();b.dispose();
});

test('Sprint 2 complete transaction stores editable objects and retains named draft and reference notes',async()=>{
 const api=await import('../src/visual-workbench/creator.mjs');const model=await import('../src/visual-workbench/model.mjs');
 assert.equal(typeof model.composeEditableContent,'function');
 const {service,session,storage}=await confirmedService();await service.renameActiveDraft('Named production work');
 const referenced={...session,action_reference_note:'Same red ribbon'};await service.save(service.activeRecord().content_package,{generationSession:referenced});
 const copy=service.activeRecord().content_package;const final={...copy,source_input:referenced.text_draft.source_input,titles:referenced.text_draft.titles,selectedTitle:referenced.text_draft.selected_title,body:referenced.text_draft.body,tags:referenced.text_draft.tags,generation:{...copy.generation,mode:'PROVIDER',provider:'volcengine-ark',source_draft_id:referenced.text_draft.draft_id,strategy:'resumable_public_image_steps_v1'}};
 let prepared=0;const provider={fetchImageMediaDelta:async()=>[],generateImages:async(input,consume)=>{
  assert.equal(service.activeRecord().display_name,'Named production work');assert.equal(service.pending().operation_snapshot.reference_note,'Same red ribbon');
  await consume(readyImageResponse());assert.equal(service.activeRecord().display_name,'Named production work');
  await consume({...readyImageResponse('PARTIAL'),progress:{...readyImageResponse().progress,completed_image_steps:1,actual_image_calls:1,remaining_image_calls:5}});assert.equal(service.activeRecord().display_name,'Named production work');
  const result={status:'COMPLETE',content_package:final,media_delta:[]};await consume(result);return result;
 }};
 const result=await api.runImageGeneration({provider,service,session:referenced,prepareContent:content=>{prepared++;return model.composeEditableContent(content);}});
 assert.equal(prepared,1);assert.equal(result.status,'COMPLETE');assert.equal(service.pending(),null);const b=storageAdapter(storage);await b.load();
 assert.equal(b.activeRecord().display_name,'Named production work');assert.equal(b.session().action_reference_note,'Same red ribbon');assert.equal(b.activeRecord().content_package.body,referenced.text_draft.body);
 for(const p of b.activeRecord().content_package.pages)assert.ok(p.html_state.free_objects.length>0);
 service.dispose();b.dispose();
});


test('reference upload accepts modern File.bytes method without confusing it with a bytes buffer',async()=>{
 const {readReferenceFiles}=await import('../src/visual-workbench/creator.mjs');const raw=new Uint8Array([1,2,3]);const file={name:'test.png',type:'image/png',size:3,bytes:async()=>raw,arrayBuffer:async()=>raw.buffer};
 const [result]=await readReferenceFiles([file]);assert.deepEqual(result.bytes,raw);assert.equal(result.name,'test.png');await assert.rejects(()=>readReferenceFiles([{...file,size:21000000}]),/FILE_INVALID/);
});


test('layout failure preserves paid completion and returns an explicit repair requirement',async()=>{
 const {service,session}=await confirmedService();await service.renameActiveDraft('Recoverable named work');
 const c=service.activeRecord().content_package,d=session.text_draft;
 const final={...c,source_input:d.source_input,titles:d.titles,selectedTitle:d.selected_title,body:d.body,tags:d.tags,generation:{...c.generation,mode:'PROVIDER',provider:'volcengine-ark',source_draft_id:d.draft_id,strategy:'resumable_public_image_steps_v1'}};
 const provider={fetchImageMediaDelta:async()=>[],generateImages:async(_input,consume)=>{const result={status:'COMPLETE',content_package:final,media_delta:[]};await consume(result);return result;}};
 const result=await runImageGeneration({provider,service,session,prepareContent:()=>{throw new Error('Page requires split');}});
 assert.equal(result.status,'COMPLETE');assert.equal(result.layout_error,'Page requires split');assert.equal(service.pending(),null);assert.equal(service.activeRecord().display_name,'Recoverable named work');assert.equal(service.activeRecord().content_package.body,d.body);service.dispose();
});

test('input/readiness UI preserves ledger guard and allows backup during unfinished generation',async()=>{
 const {readFile}=await import('node:fs/promises');const main=await readFile(new URL('../src/visual-workbench/main.jsx',import.meta.url),'utf8');
 assert.match(main,/credential_mode==='SERVER_MANAGED'/);assert.match(main,/if\(!service.pending\(\)\)await saveCurrent\(\);download/);
 assert.match(main,/disabled=\{exportBlocked\|\|!!pendingImage\}/);
 assert.match(main,/e.requiresAccess\|\|e.httpStatus===401/);
});


test('access policy distinguishes required authentication from an authenticated session',async()=>{
 const {requiresStudioAccess,updateActionReferences}=await import('../src/visual-workbench/creator.mjs');
 assert.equal(requiresStudioAccess({access_required:true,authenticated:true,status:'LIVE_VERIFIED'}),false);
 assert.equal(requiresStudioAccess({access_required:true,authenticated:false}),true);
 assert.throws(()=>updateActionReferences(emptyAuthoringSession(),{note:'x'.repeat(1001)}),/MAX_1000/);
});

test('named pending work reloads and DISCOVER uses the frozen reference note',async()=>{
 const {service,session,storage}=await confirmedService();await service.renameActiveDraft('Resume name');
 const original={...session,action_reference_note:'Frozen instructions'};await service.save(service.activeRecord().content_package,{generationSession:original});
 const modes=[];const provider={fetchImageMediaDelta:async()=>[],generateImages:async(input,consume)=>{modes.push(input.mode);const reply=readyImageResponse('READY_DISCOVERY');await consume(reply);return reply;}};
 await runImageGeneration({provider,service,session:original,discoveryOnly:true});service.dispose();
 const restored=storageAdapter(storage);await restored.load();assert.equal(restored.activeRecord().display_name,'Resume name');
 await runImageGeneration({provider,service:restored,session:{...restored.session(),action_reference_note:'Do not substitute this'},discoveryOnly:true});
 assert.deepEqual(modes,['START','DISCOVER']);assert.equal(restored.pending().operation_snapshot.reference_note,'Frozen instructions');assert.equal(restored.activeRecord().display_name,'Resume name');restored.dispose();
});

test('failed editable layout preserves the completed paid-result record instead of losing or regenerating it',async()=>{
 const {service,session}=await confirmedService();await service.renameActiveDraft('Preserve result');const old=service.activeRecord().content_package;
 const final={...old,source_input:session.text_draft.source_input,titles:session.text_draft.titles,selectedTitle:session.text_draft.selected_title,body:session.text_draft.body,tags:session.text_draft.tags,generation:{...old.generation,mode:'PROVIDER',provider:'volcengine-ark',source_draft_id:session.text_draft.draft_id,strategy:'resumable_public_image_steps_v1'}};
 let count=0;const provider={fetchImageMediaDelta:async()=>[],generateImages:async(input,consume)=>{count++;const reply={status:'COMPLETE',content_package:final,media_delta:[]};await consume(reply);return reply;}};
 const result=await runImageGeneration({provider,service,session,prepareContent:()=>{throw new Error('LAYOUT_REQUIRES_SPLIT');}});
 assert.equal(count,1);assert.equal(result.status,'COMPLETE');assert.equal(result.layout_error,'LAYOUT_REQUIRES_SPLIT');assert.equal(service.activeRecord().display_name,'Preserve result');assert.equal(service.activeRecord().content_package.body,session.text_draft.body);assert.equal(service.pending(),null);service.dispose();
});


test('full backup to empty origin preserves named pending recovery and all draft identities',async()=>{
 const {service,session}=await confirmedService();await service.renameActiveDraft('Pending named work');
 const provider={fetchImageMediaDelta:async()=>[],generateImages:async(input,consume)=>{await consume(readyImageResponse());return readyImageResponse();}};
 await runImageGeneration({provider,service,session,discoveryOnly:true});const record=structuredClone(service.activeRecord());const backup=await service.backup();const restored=storageAdapter(memoryStorage());await restored.load();
 await restored.importFile(JSON.stringify(backup));assert.equal(restored.activeRecord().draft_id,record.draft_id);assert.equal(restored.activeRecord().display_name,'Pending named work');assert.deepEqual(restored.pending(),record.pending_image_operation);assert.equal(restored.session().image_resume.resume_run_id,'run-mock-1');
 const occupied=storageAdapter(memoryStorage());await occupied.load();await occupied.save(createDemo());const before=JSON.stringify(occupied.workspace());await assert.rejects(()=>occupied.importFile(JSON.stringify(backup)),/PENDING_BACKUP_REQUIRES_EMPTY_WORKSPACE/);assert.equal(JSON.stringify(occupied.workspace()),before);
 service.dispose();restored.dispose();occupied.dispose();
});


test('empty-origin complete backup restore rejects incompatible Fabric edits before any workspace write',async()=>{
 const storage=memoryStorage(),service=storageAdapter(storage);await service.load();await service.save(createDemo());const backup=await service.backup();backup.workspace.drafts[0].content_package.pages[0].editor_mode='fabric';
 const empty=memoryStorage(),target=storageAdapter(empty);await target.load();await assert.rejects(()=>target.importFile(JSON.stringify(backup)));assert.equal(empty.data.size,0);assert.equal(target.workspace(),null);service.dispose();target.dispose();
});


test('single-image alternatives preserve source and restore one selected image with stale-page protection',async()=>{
 const {createPageVariantSession,applyPageVariant}=await import('../src/visual-workbench/creator.mjs');
 const {composeEditableContent}=await import('../src/visual-workbench/model.mjs');
 const storage=memoryStorage(),service=storageAdapter(storage);await service.load();
 const seed=createDemo();seed.body=textDraft().body;seed.pages[1].visual="character";seed.pages[1].image_style.hidden=false;await service.save(composeEditableContent(seed));const original=structuredClone(service.activeRecord());
 const session=await createPageVariantSession(original,{pageIndex:1,objectId:'hero-image'});
 await service.save(original.content_package,{asNew:true,generationSession:session,displayName:'配图方案'});
 const candidate=structuredClone(service.activeRecord().content_package);candidate.generation={...candidate.generation,mode:'PROVIDER',provider:'volcengine-ark',source_draft_id:session.text_draft.draft_id};
 const bytes=new Uint8Array([255,216,255,217]);const {putVerifiedMedia}=await import('../src/media-asset-store.mjs');const asset=await putVerifiedMedia(service.mediaStore,{bytes,mime:'image/jpeg',name:'test-variant'});
 candidate.pages=candidate.pages.slice(0,3).map(p=>({...p,image_style:{...p.image_style,src:asset.media_ref}}));candidate.visible_pages=3;
 await service.save(candidate,{generationSession:{...session,assembled_draft_id:session.text_draft.draft_id}});
 assert.deepEqual(service.workspace().drafts.find(d=>d.draft_id===original.draft_id),original);
 const output=await applyPageVariant({service,candidateIndex:1});assert.equal(service.activeRecord().draft_id,original.draft_id);
 const after=service.activeRecord().content_package;assert.deepEqual(after.pages[0],original.content_package.pages[0]);assert.deepEqual(after.pages[2],original.content_package.pages[2]);
 assert.deepEqual(after.pages[1].html_state,original.content_package.pages[1].html_state);assert.equal(after.pages[1].body,original.content_package.pages[1].body);assert.equal(after.pages[1].image_style.src,asset.media_ref);
 assert.equal(output.target.source_page_index,1);
 const variants=service.workspace().drafts.find(d=>d.generation_session?.image_variant_target);await service.activateDraft(variants.draft_id);
 await assert.rejects(()=>applyPageVariant({service,candidateIndex:0}),/原页.*变化/);
});


test('discovery ERROR is never reported as saved recovery and never releases or retries a paid lane',async()=>{
 const {service,session}=await confirmedService();
 const bootstrap={fetchImageMediaDelta:async()=>[],generateImages:async(input,onProgress)=>{await onProgress(readyImageResponse());return readyImageResponse();}};
 await runImageGeneration({provider:bootstrap,service,session,discoveryOnly:true});const before=structuredClone(service.activeRecord());let calls=0;
 const provider={fetchImageMediaDelta:async()=>[],generateImages:async input=>{calls++;assert.equal(input.mode,'DISCOVER');return {...readyImageResponse(),status:'ERROR',error:{code:'IMAGE_LEDGER_RUN_MISSING'},upstream_calls:0};}};
 await assert.rejects(()=>runImageGeneration({provider,service,session:service.session(),discoveryOnly:true}),/IMAGE_LEDGER_RUN_MISSING/);assert.equal(calls,1);assert.deepEqual(service.activeRecord(),before);
});


test('explicit retry resubmits exactly the same fresh BOOTSTRAP only after missing-run discovery',async()=>{
 const {service,session}=await confirmedService();const first=[];
 await assert.rejects(()=>runImageGeneration({service,session,provider:{fetchImageMediaDelta:async()=>[],generateImages:async request=>{first.push(request);throw new Error('IMAGE_LEDGER_CAPACITY_EXHAUSTED');}}}),/CAPACITY_EXHAUSTED/);
 const frozen=structuredClone(service.pending());assert.equal(frozen.protocol_state,'BOOTSTRAP');
 const missing={status:'ERROR',error:{code:'IMAGE_LEDGER_RUN_MISSING'}};const calls=[];
 const provider={fetchImageMediaDelta:async()=>[],generateImages:async(request,consume)=>{calls.push(request);if(request.mode==='DISCOVER')return missing;await consume(readyImageResponse());throw Object.assign(new Error('test checkpoint stop'),{intentionalStop:true,checkpointPersisted:true});}};
 await assert.rejects(()=>runImageGeneration({service,session,provider,discoveryOnly:true}),/IMAGE_LEDGER_RUN_MISSING/);assert.deepEqual(calls.map(x=>x.mode),['DISCOVER']);
 calls.length=0;const result=await runImageGeneration({service,session,provider});assert.equal(result.status,'CHECKPOINTED');assert.deepEqual(calls.map(x=>x.mode),['DISCOVER','START']);assert.deepEqual(calls[1],first[0]);assert.equal(service.pending().operation_nonce,frozen.operation_nonce);assert.equal(service.pending().protocol_state,'READY');
});
test('unknown or expired BOOTSTRAP cannot be treated as a safe new START',async()=>{
 const {service,session}=await confirmedService();await assert.rejects(()=>runImageGeneration({service,session,provider:{fetchImageMediaDelta:async()=>[],generateImages:async()=>{throw new Error('network');}}}),/network/);
 const calls=[];let response={status:'UNKNOWN'};const provider={fetchImageMediaDelta:async()=>[],generateImages:async request=>{calls.push(request);return response;}};
 await assert.rejects(()=>runImageGeneration({service,session,provider}),/UNKNOWN/);assert.deepEqual(calls.map(x=>x.mode),['DISCOVER']);calls.length=0;
 response={status:'ERROR',error:{code:'IMAGE_LEDGER_RUN_MISSING'}};const originalNow=Date.now;
 try{Date.now=()=>originalNow()+8*86400000;await assert.rejects(()=>runImageGeneration({service,session,provider}),/IMAGE_LEDGER_RUN_MISSING/);}finally{Date.now=originalNow;}
 assert.deepEqual(calls.map(x=>x.mode),['DISCOVER']);
});
