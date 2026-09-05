import {createProfileV2} from '../profile-v2.mjs';
import {createMediaAssetStore} from '../media-asset-store.mjs';
import {createWorkspaceV3Coordinator,activeDraftRecordV3,activateDraftRecordV3,createDraftRecordV3,buildWorkspaceEnvelopeV3,saveDraftRecordV3,materializePersistentMediaRefsV3,hydrateWorkspaceV3View,buildWorkspaceBackupV3,parseWorkspaceBackupV3,WORKSPACE_ENVELOPE_V3_STORAGE_KEY} from '../workspace-state.mjs';
import {importEditableContent} from './model.mjs';
export const STORAGE_KEYS={envelope:'xiaoshimei-studio.workspace.v2',envelopeV3:WORKSPACE_ENVELOPE_V3_STORAGE_KEY};
export function createVisualStorage({storage=globalThis.localStorage,mediaStore=createMediaAssetStore(),lockManager=globalThis.navigator?.locks}={}) {
  const coordinator=createWorkspaceV3Coordinator({storage,mediaStore,lockManager,keys:STORAGE_KEYS});
  let base=null;const views=[];
  async function viewOf(workspace){
    const view=await hydrateWorkspaceV3View({workspace,mediaStore});
    if(!view.ok)throw new Error('图片素材缺失或损坏；原草稿保持不变。');
    views.push(view);return view.workspace.drafts.find(d=>d.draft_id===view.workspace.active_draft_id).content_package;
  }
  async function load(){
    base=coordinator.snapshot();
    if(!base.ok)throw new Error('本机草稿无法读取；未清空或覆盖原数据。');
    if(!base.workspace && storage.getItem(STORAGE_KEYS.envelope)){
      const migration=await coordinator.migrateFromV2();
      if(!migration.ok)throw new Error('旧草稿迁移未完成：'+migration.code);
      base=coordinator.snapshot();
    }
    if(!base.workspace)return null;
    const draft=activeDraftRecordV3(base.workspace);
    // Pending generation is part of the same DraftRecord. The new workbench
    // must restore it visibly; only ordinary edits/saves remain locked until
    // the recovery/image adapter settles the operation.
    return viewOf(base.workspace);
  }
  async function save(content,{asNew=false,profile=null,generationSession=undefined}={}) {
    if(!base)await load();
    if(base.workspace&&activeDraftRecordV3(base.workspace).pending_image_operation)throw new Error('未完成的生成任务需要先恢复；本次未覆盖草稿。');
    const persistent=await materializePersistentMediaRefsV3({value:content,mediaStore,resolveBlobUrl:async url=>{
      const response=await fetch(url);if(!response.ok)throw new Error('图片读取失败');return response.blob();
    }});
    let next;
    if(!base.workspace || asNew){
      const id=crypto.randomUUID();
      const draft=createDraftRecordV3({draftId:id,contentPackage:persistent.value,generationSession:generationSession===undefined?null:generationSession});
      next=buildWorkspaceEnvelopeV3({profile:base.workspace?.profile||profile||createProfileV2(),activeDraftId:id,previousDraftId:base.workspace?.active_draft_id||null,drafts:[...(base.workspace?.drafts||[]),draft],legacyV2Source:base.workspace?.legacy_v2_source||null});
    }else next=saveDraftRecordV3(base.workspace,{contentPackage:persistent.value,...(generationSession===undefined?{}:{generationSession})});
    const receipt=await coordinator.fullCas({expectedWorkspaceToken:base.workspace_token,workspace:next,reason:'VISUAL_EDITOR_SAVE'});
    if(!receipt.ok)throw new Error(receipt.code==='WORKSPACE_V3_CAS_CONFLICT'?'另一个标签页已更新草稿。本次未覆盖，请先下载备份或重新打开。':'保存失败：'+receipt.code);
    base=coordinator.snapshot();
    return {content:await viewOf(base.workspace),workspace:base.workspace,receipt};
  }
  async function sync({allowPending=false}={}){
    base=coordinator.snapshot();
    if(!base.ok)throw new Error('本机草稿无法读取；未清空或覆盖原数据。');
    if(!base.workspace)return {content:null,workspace:null,record:null};
    const record=activeDraftRecordV3(base.workspace);
    if(record.pending_image_operation&&!allowPending)throw new Error('未完成的生成任务需要先恢复；本次未覆盖草稿。');
    return {content:await viewOf(base.workspace),workspace:base.workspace,record};
  }
  async function importFile(raw){
    let value=JSON.parse(raw);let content=value;let importedProfile=null;let importedSession=undefined;
    if(value.schema==='xiaoshimei.workspace-backup.v3'){
      const backup=await parseWorkspaceBackupV3(raw);
      await mediaStore.importMediaAssets(backup.media_assets,{expectedRefs:backup.media_assets.map(a=>a.media_ref)});
      const record=activeDraftRecordV3(backup.workspace);content=record.content_package;importedSession=record.generation_session;importedProfile=backup.workspace.profile;
    }else if(value.schema==='xiaoshimei.workspace-backup.v2'){
      const w=value.workspace;const record=w?.drafts?.find(d=>d.draft_id===w.active_draft_id);content=record?.content_package;importedSession=record?.generation_session;
    }else if(value.schema==='xiaoshimei.workspace-backup.v1'){
      content=value.current_content||value.currentContent;importedSession=value.generation_session||value.generationSession;
    }
    const parsed=importEditableContent(content);
    // A backup enters as a new editable draft, never as a replacement authority.
    return save(parsed,{asNew:true,profile:importedProfile,generationSession:importedSession});
  }
  const activeRecord=()=>base?.workspace?activeDraftRecordV3(base.workspace):null;
  const recoveryDrafts=()=>base?.workspace?.drafts?.filter(d=>d.draft_id!==base.workspace.active_draft_id&&d.pending_image_operation).map(d=>({draft_id:d.draft_id,title:d.content_package?.selectedTitle||d.content_package?.pages?.[0]?.title||'恢复稿',protocol_state:d.pending_image_operation.protocol_state,updated_at:d.updated_at}))||[];
  async function activateDraft(draftId){
    if(!base?.workspace)throw new Error('本机没有可切换的草稿。');
    const activated=activateDraftRecordV3(base.workspace,draftId);
    const receipt=await coordinator.fullCas({expectedWorkspaceToken:base.workspace_token,workspace:activated.workspace,reason:'VISUAL_OPEN_RECOVERY_DRAFT'});
    if(!receipt.ok)throw new Error(receipt.code==='WORKSPACE_V3_CAS_CONFLICT'?'另一个标签页已更新草稿；未切换。':'恢复稿切换失败：'+receipt.code);
    return sync({allowPending:true});
  }
  return {load,save,importFile,sync,activateDraft,recoveryDrafts,mediaStore,coordinator,workspace:()=>base?.workspace,activeRecord,
    session:()=>activeRecord()?.generation_session||null,
    pending:()=>activeRecord()?.pending_image_operation||null,
    profile:()=>base?.workspace?.profile||createProfileV2(),
    backup:()=>buildWorkspaceBackupV3({workspace:base.workspace,mediaStore}),
    dispose:()=>views.splice(0).forEach(v=>v.release())};
}
