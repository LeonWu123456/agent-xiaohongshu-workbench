import {createProfileV2} from '../profile-v2.mjs';
import {createMediaAssetStore} from '../media-asset-store.mjs';
import {createWorkspaceV3Coordinator,activeDraftRecordV3,activateDraftRecordV3,createDraftRecordV3,buildWorkspaceEnvelopeV3,saveDraftRecordV3,materializePersistentMediaRefsV3,hydrateWorkspaceV3View,buildWorkspaceBackupV3,parseWorkspaceBackupV3,restoreWorkspaceBackupV3,forkDraftForReferenceEditV3,WORKSPACE_ENVELOPE_V3_STORAGE_KEY} from '../workspace-state.mjs';
import {importEditableContent} from './model.mjs';
export const STORAGE_KEYS={envelope:'xiaoshimei-studio.workspace.v2',envelopeV3:WORKSPACE_ENVELOPE_V3_STORAGE_KEY};

// Read-only description of the existing import contract, not a library merge.
function visualImportSummary(value,hasWorkspace){
 const library=['xiaoshimei.workspace-backup.v3','xiaoshimei.workspace-backup.v2'].includes(value?.schema);
 const records=library?value.workspace?.drafts:null;
 const active=library?records?.find(d=>d.draft_id===value.workspace.active_draft_id):null;
 if(library&&(!Array.isArray(records)||!records.length||!active))throw new Error('备份中的作品清单或活动作品无效。');
 const sourceCount=library?records.length:1,restoredWorkspace=value?.schema==='xiaoshimei.workspace-backup.v3'&&!hasWorkspace;
 const importedCount=restoredWorkspace?sourceCount:1,skippedCount=sourceCount-importedCount;
 const activeTitle=String(active?.display_name||active?.content_package?.selectedTitle||active?.content_package?.pages?.[0]?.title||'未命名作品');
 const confirmation=skippedCount>0?`备份中有 ${sourceCount} 份作品。本次只新增活动作品「${activeTitle}」1 份，其余 ${skippedCount} 份不会导入。\n\n现有作品保留；取消不会改动作品库。需要导入其余作品时，请分别使用单作品备份，不要清空当前作品库。\n\n继续只导入这一份？`:null;
 const success=restoredWorkspace?`已恢复 ${importedCount} 份作品与配图恢复点。`:skippedCount>0?`备份共 ${sourceCount} 份，本次导入「${activeTitle}」1 份，其余 ${skippedCount} 份未导入；现有作品保留。`:'已作为新草稿导入，原有作品保留。';
 return {sourceCount,importedCount,skippedCount,activeTitle,restoredWorkspace,confirmation,success};
}
export async function previewVisualImport(raw,{hasWorkspace=false}={}){
 let value=JSON.parse(raw),content=value;
 if(value?.schema==='xiaoshimei.workspace-backup.v3'){
  value=await parseWorkspaceBackupV3(raw);
  for(const record of value.workspace.drafts)importEditableContent(record.content_package);
  if(hasWorkspace&&value.workspace.drafts.some(r=>r.pending_image_operation))throw new Error('PENDING_BACKUP_REQUIRES_EMPTY_WORKSPACE: 这份备份含待恢复任务，请在空白浏览器工作区导入完整备份；现有作品未改动。');
 }else{
  if(value?.schema==='xiaoshimei.workspace-backup.v2')content=value.workspace?.drafts?.find(d=>d.draft_id===value.workspace.active_draft_id)?.content_package;
  else if(value?.schema==='xiaoshimei.workspace-backup.v1')content=value.current_content||value.currentContent;
  importEditableContent(content);
 }
 return visualImportSummary(value,hasWorkspace);
}

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
  async function save(content,{asNew=false,profile=null,generationSession=undefined,displayName=undefined}={}) {
    if(!base)await load();
    if(base.workspace&&activeDraftRecordV3(base.workspace).pending_image_operation)throw new Error('未完成的生成任务需要先恢复；本次未覆盖草稿。');
    const persistent=await materializePersistentMediaRefsV3({value:content,mediaStore,resolveBlobUrl:async url=>{
      const response=await fetch(url);if(!response.ok)throw new Error('图片读取失败');return response.blob();
    }});
    let next;
    if(!base.workspace || asNew){
      const id=crypto.randomUUID();
      const draft=createDraftRecordV3({draftId:id,contentPackage:persistent.value,displayName,generationSession:generationSession===undefined?null:generationSession});
      next=buildWorkspaceEnvelopeV3({profile:base.workspace?.profile||profile||createProfileV2(),activeDraftId:id,previousDraftId:base.workspace?.active_draft_id||null,drafts:[...(base.workspace?.drafts||[]),draft],legacyV2Source:base.workspace?.legacy_v2_source||null});
    }else next=saveDraftRecordV3(base.workspace,{contentPackage:persistent.value,displayName,...(generationSession===undefined?{}:{generationSession})});
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
    let value=JSON.parse(raw);let content=value;let importedProfile=null;let importedSession=undefined;let importedDisplayName;
    let importSummary=visualImportSummary(value,true);
    if(value.schema==='xiaoshimei.workspace-backup.v3'){
      const backup=await parseWorkspaceBackupV3(raw);
      for(const record of backup.workspace.drafts)importEditableContent(record.content_package);
      if(!base)await load();
      importSummary=visualImportSummary(backup,Boolean(base.workspace));
      if(!base.workspace){
        const receipt=await restoreWorkspaceBackupV3({serialized:raw,coordinator,mediaStore,expectedWorkspaceToken:base.workspace_token});
        if(!receipt.ok)throw new Error('BACKUP_RESTORE_NOT_COMMITTED:'+receipt.code);
        return {...await sync({allowPending:true}),restoredWorkspace:true,receipt,importSummary};
      }
      if(backup.workspace.drafts.some(record=>record.pending_image_operation))throw new Error('PENDING_BACKUP_REQUIRES_EMPTY_WORKSPACE: \u8fd9\u4efd\u5907\u4efd\u542b\u5f85\u6062\u590d\u4efb\u52a1\uff0c\u8bf7\u5728\u7a7a\u767d\u6d4f\u89c8\u5668\u5de5\u4f5c\u533a\u5bfc\u5165\u5b8c\u6574\u5907\u4efd\uff1b\u73b0\u6709\u4f5c\u54c1\u672a\u6539\u52a8\u3002');
      await mediaStore.importMediaAssets(backup.media_assets,{expectedRefs:backup.media_assets.map(a=>a.media_ref)});
      const record=activeDraftRecordV3(backup.workspace);content=record.content_package;importedSession=record.generation_session;importedProfile=backup.workspace.profile;importedDisplayName=record.display_name;
    }else if(value.schema==='xiaoshimei.workspace-backup.v2'){
      const w=value.workspace;const record=w?.drafts?.find(d=>d.draft_id===w.active_draft_id);content=record?.content_package;importedSession=record?.generation_session;
    }else if(value.schema==='xiaoshimei.workspace-backup.v1'){
      content=value.current_content||value.currentContent;importedSession=value.generation_session||value.generationSession;
    }
    const parsed=importEditableContent(content);
    // A backup enters as a new editable draft, never as a replacement authority.
    return {...await save(parsed,{asNew:true,profile:importedProfile,generationSession:importedSession,displayName:importedDisplayName}),importSummary};
  }
  const drafts=()=>base?.workspace?.drafts.map(record=>({
    draft_id:record.draft_id,
    title:record.display_name||record.content_package?.selectedTitle||record.content_package?.pages?.[0]?.title||'未命名作品',
    updated_at:record.updated_at,
    created_at:record.created_at,
    page_count:record.content_package?.visible_pages||record.content_package?.pages?.length||0,
    pending:Boolean(record.pending_image_operation),
    active:record.draft_id===base.workspace.active_draft_id,
  }))?.sort((a,b)=>b.updated_at.localeCompare(a.updated_at))||[];
  async function createDraft(content){
    if(!base)await load();
    if(base?.workspace&&activeDraftRecordV3(base.workspace).pending_image_operation)throw new Error('当前稿有未完成的配图任务；请先检查或切换作品。');
    return save(content,{asNew:true,generationSession:null});
  }
  async function duplicateActiveDraft(){
    if(!base)await load();
    if(!base?.workspace)throw new Error('当前还没有可复制的作品。');
    if(activeDraftRecordV3(base.workspace).pending_image_operation)throw new Error('当前稿有未完成的配图任务；不能复制这个运行中的稿件。');
    const fork=forkDraftForReferenceEditV3(base.workspace,{newDraftId:crypto.randomUUID()});
    const source=activeDraftRecordV3(base.workspace);
    const workspace=saveDraftRecordV3(fork.workspace,{displayName:(source.display_name||source.content_package.selectedTitle).slice(0,110)+'（副本）'});
    const receipt=await coordinator.fullCas({expectedWorkspaceToken:base.workspace_token,workspace,reason:'VISUAL_DUPLICATE_DRAFT'});
    if(!receipt.ok)throw new Error(receipt.code==='WORKSPACE_V3_CAS_CONFLICT'?'另一个标签页已更新作品库；未复制。':'复制作品失败：'+receipt.code);
    base=coordinator.snapshot();
    return {content:await viewOf(base.workspace),workspace:base.workspace,receipt};
  }
  async function renameActiveDraft(displayName){
    if(typeof displayName!=='string'||!displayName.trim()||displayName.trim().length>120)throw new Error('作品名称须为1–120个字符。');
    if(!base)await load();
    if(!base?.workspace)throw new Error('请先新建或保存作品。');
    if(activeDraftRecordV3(base.workspace).pending_image_operation)throw new Error('当前稿有未完成的配图任务；请先恢复任务。');
    const workspace=saveDraftRecordV3(base.workspace,{displayName:displayName.trim()});
    const receipt=await coordinator.fullCas({expectedWorkspaceToken:base.workspace_token,workspace,reason:'VISUAL_RENAME_DRAFT'});
    if(!receipt.ok)throw new Error(receipt.code==='WORKSPACE_V3_CAS_CONFLICT'?'另一个标签页已更新作品库；本次未重命名。':'重命名失败：'+receipt.code);
    base=coordinator.snapshot();
    return {content:await viewOf(base.workspace),workspace:base.workspace,receipt};
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
  return {load,save,importFile,sync,activateDraft,recoveryDrafts,drafts,createDraft,duplicateActiveDraft,renameActiveDraft,mediaStore,coordinator,workspace:()=>base?.workspace,activeRecord,
    session:()=>activeRecord()?.generation_session||null,
    pending:()=>activeRecord()?.pending_image_operation||null,
    profile:()=>base?.workspace?.profile||createProfileV2(),
    backup:()=>buildWorkspaceBackupV3({workspace:base.workspace,mediaStore}),
    dispose:()=>views.splice(0).forEach(v=>v.release())};
}
