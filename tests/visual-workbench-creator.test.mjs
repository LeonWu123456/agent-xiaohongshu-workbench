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
