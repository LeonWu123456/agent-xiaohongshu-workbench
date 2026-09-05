import {replacePageImage} from './model.mjs';
import {normalizePageImageVariantTarget} from '../provider-contract.mjs';
import { createLocalHttpProvider } from '../provider-client.mjs';
import { buildGenerationContract } from '../profile-v2.mjs';
import { defaultPromptValues, promptContextForProvider } from '../prompt-context.mjs';
import {
  normalizeAuthoringSession, AUTHORING_SESSION_SCHEMA, createRestartablePendingImageOperationV3,
  rebuildPendingImageStartV3, commitDraftImageProgressV3, commitDraftImageCompletionV3,
  commitDraftImagePlannerFailureV3, createDraftRecordV3, draftRecordToken,
} from '../workspace-state.mjs';
import { textDraftConfirmationIssue } from '../text-draft-policy.mjs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function defaultProviderEndpoint(locationValue = globalThis.location) {
  const location = locationValue || { hostname: '127.0.0.1', origin: 'http://127.0.0.1' };
  return LOOPBACK.has(String(location.hostname))
    ? 'http://127.0.0.1:4175/generate'
    : `${location.origin}/api/provider/generate`;
}

export function createVisualProvider(options = {}) {
  const endpoint = options.endpoint || defaultProviderEndpoint(options.location);
  return createLocalHttpProvider({ endpoint, fetchImpl: options.fetchImpl || globalThis.fetch });
}

export function emptyAuthoringSession(input = {}) {
  return normalizeAuthoringSession({
    schema: AUTHORING_SESSION_SCHEMA,
    topic: String(input.topic || ''), pillar: String(input.pillar || 'wellness'), goal: String(input.goal || 'save'),
    text_requirements: String(input.text_requirements || ''), text_draft: null, text_confirmed: false,
    assembled_draft_id: null, image_count_mode: 'AUTO', custom_image_count: 3,
    production_mode: 'smart', image_resume: null, action_reference_manifest: [], action_reference_note: '',
  });
}
export function sessionWithTextDraft(sessionValue, draft, input = {}) {
  const previous = sessionValue || emptyAuthoringSession(input);
  return normalizeAuthoringSession({
    ...previous,
    schema: AUTHORING_SESSION_SCHEMA,
    topic: String(input.topic ?? previous.topic ?? draft.source_input),
    pillar: String(input.pillar ?? previous.pillar ?? draft.pillar),
    goal: String(input.goal ?? previous.goal ?? draft.goal),
    text_requirements: String(input.text_requirements ?? previous.text_requirements ?? ''),
    text_draft: draft,
    text_confirmed: false,
    assembled_draft_id: null,
    custom_image_count: draft.recommended_image_count,
    image_resume: null,
  });
}

export function editTextSession(sessionValue, field, value, index = null) {
  const session = normalizeAuthoringSession(sessionValue);
  if (!session?.text_draft) throw new TypeError('TEXT_DRAFT_MISSING');
  const draft = structuredClone(session.text_draft);
  if (field === 'selected_title') {
    draft.titles = draft.titles.map(title => title === draft.selected_title ? String(value) : title);
    draft.selected_title = String(value);
  } else if (field === 'tag') draft.tags[index] = String(value);
  else draft[field] = String(value);
  return normalizeAuthoringSession({ ...session, text_draft: draft, text_confirmed: false, assembled_draft_id: null, image_resume: null });
}
export function chooseTextTitle(sessionValue, title) {
  const session = normalizeAuthoringSession(sessionValue);
  if (!session?.text_draft || !session.text_draft.titles.includes(title)) throw new TypeError('TEXT_TITLE_INVALID');
  return normalizeAuthoringSession({ ...session, text_draft: { ...session.text_draft, selected_title: title }, text_confirmed: false, assembled_draft_id: null });
}

export function confirmTextSession(sessionValue) {
  const session = normalizeAuthoringSession(sessionValue);
  const issue = textDraftConfirmationIssue(session?.text_draft);
  if (issue) {
    const error = new Error(issue.detail);
    error.code = issue.code;
    error.title = issue.title;
    throw error;
  }
  return normalizeAuthoringSession({ ...session, text_confirmed: true, image_resume: null });
}

export async function generateTextDraft({ provider, profile, topic, pillar = 'wellness', goal = 'save', textRequirements = '', promptValues = null } = {}) {
  if (!provider?.generateTextDraft) throw new TypeError('TEXT_PROVIDER_UNAVAILABLE');
  if (String(topic || '').trim().length < 2) throw new TypeError('INPUT_TOO_SHORT');
  const values = { ...defaultPromptValues(), ...(promptValues || {}) };
  return provider.generateTextDraft({
    topic: String(topic).trim(), text_requirements: String(textRequirements || ''), pillar, goal,
    profile_contract: buildGenerationContract(profile), prompt_context: promptContextForProvider(values),
  });
}

export async function readProviderHealth(provider) {
  if (!provider?.checkHealth) return { status: 'UNAVAILABLE', configured: false };
  try { return await provider.checkHealth(); }
  catch (error) { return { status: 'OFFLINE', configured: false, error: String(error?.message || error) }; }
}

function nonce64(cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.getRandomValues) throw new TypeError('IMAGE_NONCE_UNAVAILABLE');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function confirmedImageDraftSnapshot(draft) {
  return {
    draft_id: draft.draft_id, source_input: draft.source_input, pillar: draft.pillar, goal: draft.goal,
    titles: [...draft.titles], selected_title: draft.selected_title, body: draft.body, tags: [...draft.tags],
    recommended_image_count: draft.recommended_image_count, facts: Array.isArray(draft.facts) ? [...draft.facts] : [],
    risks: Array.isArray(draft.risks) ? [...draft.risks] : [], content_type: draft.content_type || 'knowledge_card',
    style_lock: draft.style_lock || null, prompt_context: draft.prompt_context,
  };
}

function imageOperationSnapshot({ recordId, draft, pageCount, productionMode, referenceNote = '', variantTarget = null }) {
  return {
    schema: 'xiaoshimei.image-operation-snapshot.v1', draft_record_id: recordId,
    mutation_epoch: Date.now(), confirmed_draft: confirmedImageDraftSnapshot(draft), page_count: pageCount,
    production_mode: productionMode, reference_note: referenceNote,
    ...(variantTarget?{image_variant_target:variantTarget}:{}),
  };
}

function imageResumeFromResponse(response, attemptNonce) {
  const progress = response?.progress && typeof response.progress === 'object' ? response.progress : {};
  const resume = {
    resume_run_id: response.run_id, checkpoint_preimage_hash: response.checkpoint_preimage_sha256,
    logical_step_id: response.logical_step_id, attempt_nonce: attemptNonce,
    local_media_refs: [...new Set((response.assets || []).map(asset => asset.media_ref))], status: response.status,
  };
  ['completed_image_steps','total_image_steps','max_image_calls','actual_image_calls','remaining_image_calls'].forEach(key => {
    if (progress[key] != null) resume[key] = progress[key];
  });
  return resume;
}
function nextImageStepRequest(response, attemptNonce) {
  return { mode:'STEP', run_id:response.run_id, checkpoint_preimage:response.checkpoint_preimage,
    checkpoint_preimage_sha256:response.checkpoint_preimage_sha256, logical_step_id:response.logical_step_id,
    attempt_nonce:attemptNonce };
}
function imageDiscoveryRequest(pending) {
  return { mode:'DISCOVER', bootstrap_nonce:pending.operation_nonce, input_sha256:pending.input_hash };
}
function imageRecoveryDraftId(nonce) { return `image-recovery-${nonce.slice(0,32)}`; }
function imageResponseError(response) {
  const code=response?.error?.code || `IMAGE_RESPONSE_${response?.status || 'INVALID'}`;
  const error=new Error(code); error.providerCode=code; error.providerStage='image'; error.providerDetails=response?.progress||null;
  return error;
}

async function persistBootstrap({ service, session, pageCount, productionMode, cryptoApi }) {
  const record=service.activeRecord();
  if(!record) throw new TypeError('DRAFT_RECORD_MISSING');
  if(record.pending_image_operation) return { record, pending:record.pending_image_operation, resumed:true };
  if(!session?.text_confirmed || !session.text_draft) throw new TypeError('TEXT_NOT_CONFIRMED');
  const operationNonce=nonce64(cryptoApi);
  const pending=await createRestartablePendingImageOperationV3({
    operationNonce,
    operationSnapshot:imageOperationSnapshot({recordId:record.draft_id,draft:session.text_draft,pageCount,productionMode,referenceNote:session.action_reference_note||'',variantTarget:session.image_variant_target}),
    orderedReferenceManifest:session.action_reference_manifest||[], protocolState:'BOOTSTRAP', updatedAt:new Date().toISOString(),
  });
  const desired=createDraftRecordV3({draftId:record.draft_id,displayName:record.display_name,contentPackage:record.content_package,generationSession:session,pendingImageOperation:pending,createdAt:record.created_at,updatedAt:new Date().toISOString()});
  const receipt=await service.coordinator.mergeDraftCas({draftId:record.draft_id,expectedDraftToken:draftRecordToken(record),buildDraft:()=>desired,requireActiveDraftId:record.draft_id,reason:`VISUAL_IMAGE_BOOTSTRAP:${operationNonce}`});
  if(!receipt.ok||!receipt.target_draft?.pending_image_operation) throw new Error(`IMAGE_BOOTSTRAP_NOT_COMMITTED:${receipt.code||'UNKNOWN'}`);
  await service.sync({allowPending:true});
  return {record:service.activeRecord(),pending:service.pending(),resumed:false};
}
export async function runImageGeneration({ provider, service, session, pageCount = null, productionMode = 'smart', discoveryOnly = false, cryptoApi = globalThis.crypto, onState = null, prepareContent = null } = {}) {
  if (!provider?.generateImages || !provider?.fetchImageMediaDelta) throw new TypeError('IMAGE_PROVIDER_UNAVAILABLE');
  if (!service?.coordinator || !service?.mediaStore || !service?.activeRecord) throw new TypeError('IMAGE_STORAGE_UNAVAILABLE');
  const checkedSession = normalizeAuthoringSession(session);
  if (!checkedSession?.text_confirmed || !checkedSession.text_draft) throw new TypeError('TEXT_NOT_CONFIRMED');
  const count = pageCount == null ? checkedSession.text_draft.recommended_image_count : Number(pageCount);
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new TypeError('IMAGE_PAGE_COUNT_INVALID');
  const bootstrap = await persistBootstrap({ service, session: checkedSession, pageCount: count, productionMode, cryptoApi });
  let operationRecord = bootstrap.record;
  let expectedToken = draftRecordToken(operationRecord);
  const pending = operationRecord.pending_image_operation;
  const recoveredDraftId = imageRecoveryDraftId(pending.operation_nonce);
  const emit = value => { if (typeof onState === 'function') onState(structuredClone(value)); };
  emit({ phase:'CHECKPOINT_COMMITTED', resumed:bootstrap.resumed, draft_id:operationRecord.draft_id, operation_nonce:pending.operation_nonce });
  const initialRequest = bootstrap.resumed ? imageDiscoveryRequest(pending) : await rebuildPendingImageStartV3({ pendingImageOperation:pending, mediaStore:service.mediaStore });
  const requestModes = [initialRequest.mode];
  let completed = null;
  let layoutError = null;
  const consume = async response => {
    const mediaDelta = response.media_delta?.length ? await provider.fetchImageMediaDelta(response.media_delta) : [];
    if (response.status === 'COMPLETE') {
      let editableContent=response.content_package;
      if(typeof prepareContent==='function'){try{editableContent=await prepareContent(structuredClone(response.content_package));}catch(error){layoutError=String(error.message||error);}}
      const receipt = await commitDraftImageCompletionV3({
        coordinator:service.coordinator, mediaStore:service.mediaStore, draftId:operationRecord.draft_id,
        expectedDraftToken:expectedToken, operationSnapshot:operationRecord, recoveredDraftId,
        contentPackage:editableContent, mediaDelta,
      });
      if (receipt.action !== 'COMPLETE' || !receipt.workspace) throw new Error(`IMAGE_COMPLETION_NOT_COMMITTED:${receipt.code || 'UNKNOWN'}`);
      completed = await service.sync({allowPending:false});
      emit({ phase:'COMPLETE', request_modes:[...requestModes], recovered_draft_id:receipt.recovered_draft_id || null, layout_error:layoutError });
      return { action:'COMPLETE' };
    }
    const previous = operationRecord.pending_image_operation;
    const attemptNonce = previous?.checkpoint_preimage_hash === response.checkpoint_preimage_sha256
      && previous?.logical_step_id === response.logical_step_id && /^[0-9a-f]{64}$/.test(previous?.attempt_nonce || '')
      ? previous.attempt_nonce : nonce64(cryptoApi);
    const resume = imageResumeFromResponse(response, attemptNonce);
    const receipt = await commitDraftImageProgressV3({
      coordinator:service.coordinator, mediaStore:service.mediaStore, draftId:operationRecord.draft_id,
      expectedDraftToken:expectedToken, operationSnapshot:operationRecord, recoveredDraftId,
      imageResume:resume, responseStatus:response.status, mediaDelta,
    });
    if (receipt.action !== 'CONTINUE' || !receipt.operation_snapshot) throw new Error(`IMAGE_PROGRESS_NOT_COMMITTED:${receipt.code || 'UNKNOWN'}`);
    operationRecord = receipt.operation_snapshot;
    expectedToken = draftRecordToken(operationRecord);
    await service.sync({allowPending:true});
    emit({ phase:'CHECKPOINT_ADVANCED', status:response.status, completed_image_steps:resume.completed_image_steps || 0, request_modes:[...requestModes] });
    if (discoveryOnly) return { action:'STOP', checkpointPersisted:true, code:'DISCOVERY_CHECKPOINT_PERSISTED' };
    const request = nextImageStepRequest(response, attemptNonce);
    requestModes.push(request.mode);
    return { action:'CONTINUE', request };
  };
  try {
    const result = await provider.generateImages(initialRequest, consume);
    if (result.status === 'ERROR' && result.error?.code === 'IMAGE_PLANNER_FAILED_ZERO_IMAGE_CALLS') {
      const release = await commitDraftImagePlannerFailureV3({
        coordinator:service.coordinator, draftId:operationRecord.draft_id, expectedDraftToken:expectedToken, operationSnapshot:operationRecord,
      });
      if (release.action !== 'RELEASED') throw new Error(`IMAGE_PLANNER_FAILURE_NOT_RELEASED:${release.code || 'UNKNOWN'}`);
      await service.sync({allowPending:false});
      throw imageResponseError(result);
    }
    if (result.status !== 'COMPLETE' && !discoveryOnly) throw imageResponseError(result);
    return { status: completed ? 'COMPLETE' : result.status, content:completed?.content || null, workspace:completed?.workspace || service.workspace(), request_modes:requestModes, pending:service.pending(), layout_error:layoutError };
  } catch (error) {
    if (error?.intentionalStop === true && error?.checkpointPersisted === true) {
      return { status:'CHECKPOINTED', content:null, workspace:service.workspace(), request_modes:requestModes, pending:service.pending(), paid_continuation_required:true };
    }
    throw error;
  }
}

export function updateImageSettings(sessionValue, { imageCountMode, customImageCount, productionMode } = {}) {
  const session = normalizeAuthoringSession(sessionValue);
  if (!session?.text_draft) throw new TypeError('TEXT_DRAFT_MISSING');
  return normalizeAuthoringSession({
    ...session,
    image_count_mode: imageCountMode === undefined ? session.image_count_mode : imageCountMode,
    custom_image_count: customImageCount === undefined ? session.custom_image_count : customImageCount,
    production_mode: productionMode === undefined ? session.production_mode : productionMode,
    assembled_draft_id: null,
    image_resume: null,
  });
}


export function updateAuthoringInput(sessionValue,{topic,textRequirements}={}) {
 const session=normalizeAuthoringSession(sessionValue||emptyAuthoringSession());
 const changed=(topic!==undefined&&String(topic)!==session.topic)||(textRequirements!==undefined&&String(textRequirements)!==session.text_requirements);
 if(!changed)return session;
 return normalizeAuthoringSession({...session,topic:topic===undefined?session.topic:String(topic),text_requirements:textRequirements===undefined?session.text_requirements:String(textRequirements),text_confirmed:false,assembled_draft_id:null,image_resume:null});
}
export function updateActionReferences(sessionValue,{manifest,note}={}) {
 if(note!==undefined&&(typeof note!=='string'||note.length>1000))throw new TypeError('ACTION_REFERENCE_NOTE_MAX_1000');
 const session=normalizeAuthoringSession(sessionValue||emptyAuthoringSession());
 return normalizeAuthoringSession({...session,action_reference_manifest:manifest===undefined?session.action_reference_manifest:manifest,action_reference_note:note===undefined?session.action_reference_note:note,image_resume:null});
}
export function requiresStudioAccess(health){return Boolean(health?.status==='ACCESS_SESSION_REQUIRED'||(health?.access_required&&health?.authenticated!==true));}


export async function readReferenceFiles(files){
 if(!Array.isArray(files)||!files.length||files.length>3)throw new TypeError('ACTION_REFERENCE_COUNT_INVALID');
 const out=[];
 for(const file of files){
  if(!file||!['image/png','image/jpeg','image/webp'].includes(file.type)||!Number.isInteger(file.size)||file.size<1||file.size>20000000)throw new TypeError('ACTION_REFERENCE_FILE_INVALID');
  // Modern File.bytes is a method. Supply the library's explicit byte record,
  // rather than allowing that method to be mistaken for a byte-buffer property.
  out.push({name:file.name,type:file.type,size:file.size,bytes:new Uint8Array(await file.arrayBuffer())});
 }
 return out;
}


async function pageIdentity(page) {
 const bytes=new TextEncoder().encode(JSON.stringify(page));const hash=await crypto.subtle.digest('SHA-256',bytes);
 return [...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export async function createPageVariantSession(record,{pageIndex,objectId}={}) {
 if(record?.pending_image_operation)throw new Error('请先完成当前配图任务。');
 const content=record?.content_package,page=content?.pages?.[pageIndex],object=page?.html_state?.free_objects?.find(o=>o.id===objectId);
 if(!page||object?.kind!=='image'||!/^(hero|panel-\d+)$/.test(object.binding||''))throw new Error('请选择一张已排版的主图或插图。');
 const imageId=object.binding,panel=imageId==='hero'?page:page.info_panels?.[Number(imageId.slice(6))];
 if(!panel)throw new Error('原插图对应的场景不存在。');
 const target=normalizePageImageVariantTarget({schema:'xiaoshimei.page-image-variants-target.v1',source_draft_id:record.draft_id,source_page_index:pageIndex,source_page_sha256:await pageIdentity(page),object_id:objectId,image_id:imageId,
  title:String(panel.title||page.title).slice(0,120),body:String(panel.body||'').slice(0,2000),visual_action:String(panel.visual_action||page.visual_action||`小师妹在日常生活中演示${panel.title||page.title}`).slice(0,400),image_prompt:String(panel.image_prompt||page.image_prompt||'').slice(0,1800)});
 const old=record.generation_session||emptyAuthoringSession({topic:content.source_input,pillar:content.pillar,goal:content.goal});
 const draft={schema:'xiaoshimei.text-draft-response.v1',draft_id:'image-variants-'+crypto.randomUUID(),created_at:new Date().toISOString(),source_input:content.source_input||target.title,text_requirements:'保持原文和版式，只生成同一动作的三个配图方案',pillar:content.pillar,goal:content.goal,titles:content.titles,selected_title:content.selectedTitle,body:content.body||target.body||target.title,tags:content.tags,recommended_image_count:3,facts:[],risks:[],content_type:'knowledge_card',style_lock:old.text_draft?.style_lock||null,prompt_context:old.text_draft?.prompt_context||{},generation:{mode:'USER_FROZEN_COPY',notice:'来自已保存的原稿，未重新生成文字'}};
 return normalizeAuthoringSession({...old,schema:AUTHORING_SESSION_SCHEMA,topic:draft.source_input,text_draft:draft,text_confirmed:true,assembled_draft_id:null,image_count_mode:'CUSTOM',custom_image_count:3,production_mode:'smart',image_resume:null,image_variant_target:target});
}
export async function applyPageVariant({service,candidateIndex}={}) {
 const candidate=service.activeRecord(),session=candidate?.generation_session,target=normalizePageImageVariantTarget(session?.image_variant_target);
 if(!target||candidate.pending_image_operation||session.assembled_draft_id!==session.text_draft?.draft_id)throw new Error('配图方案尚未完成，请先恢复生成。');
 if(!Number.isInteger(candidateIndex)||candidateIndex<0||candidateIndex>2)throw new Error('请选择一个配图方案。');
 const sourceImage=candidate.content_package.pages[candidateIndex]?.image_style?.src;
 if(!/^xiaoshimei-media:\/\/sha256\/[a-f0-9]{64}$/.test(sourceImage||''))throw new Error('配图方案没有可验证的本地素材。');
 await service.mediaStore.readVerifiedMedia(sourceImage);
 const snapshot=service.coordinator.snapshot();if(!snapshot.ok)throw new Error('原稿无法读取，未替换。');
 const source=snapshot.workspace?.drafts.find(d=>d.draft_id===target.source_draft_id),page=source?.content_package.pages[target.source_page_index];
 if(!page||source.pending_image_operation||await pageIdentity(page)!==target.source_page_sha256)throw new Error('原页已经变化，为保护新编辑，本次未替换。请从原页重新生成方案。');
 const object=page.html_state?.free_objects?.find(o=>o.id===target.object_id);
 if(object?.kind!=='image'||object.binding!==target.image_id)throw new Error('原图片对象已变化，未替换。');
 const previousImage=target.image_id==='hero'?page.image_style?.src:page.info_panels?.[Number(target.image_id.slice(6))]?.image_style?.src;
 const nextPage=replacePageImage(page,target.image_id,sourceImage),content={...source.content_package,pages:source.content_package.pages.map((p,i)=>i===target.source_page_index?nextPage:p)};
 const receipt=await service.coordinator.mergeDraftCas({draftId:source.draft_id,expectedDraftToken:draftRecordToken(source),buildDraft:()=>createDraftRecordV3({draftId:source.draft_id,displayName:source.display_name,contentPackage:content,generationSession:source.generation_session,pendingImageOperation:null,createdAt:source.created_at,updatedAt:new Date().toISOString()}),reason:'VISUAL_APPLY_SINGLE_IMAGE_VARIANT'});
 if(!receipt.ok)throw new Error('原稿刚被其他标签页更新，未覆盖：'+receipt.code);
 await service.sync();const result=await service.activateDraft(source.draft_id);
 return {...result,target,previousImage};
}
