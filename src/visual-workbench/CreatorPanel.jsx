import React,{useRef,useState} from 'react';
import {requiresStudioAccess} from './creator.mjs';
import { Check, RefreshCw, Sparkles, Type, Image as ImageIcon, ShieldCheck } from 'lucide-react';
import { estimateMotherSheetPlan } from '../mother-sheet.mjs';
import { PRODUCTION_MODES } from '../production-mode.mjs';

function stateLabel(health) {
  if (health?.configured === true && new Set(['LIVE_VERIFIED','ONLINE','READY']).has(String(health?.status || health?.image_ledger_attestation_status))) return '生成服务可用';
  if (health?.configured === true) return '服务已配置';
  if (health?.status === 'CHECKING') return '检查中';
  return '生成服务未就绪';
}

export function CreatorPanel({ topic, setTopic, session, health, busy, pending, recoveryDrafts = [], imageFlow, onGenerate, onEdit, onChooseTitle, onConfirm, onRefreshHealth, onImageCount, onAutoImageCount, onProductionMode, onImageCheck, onImageRun, onOpenRecovery, onInput, onAddReferences, onRemoveReference, onReferenceNote, referenceUrls = {}, onAuthenticate }) {
  const draft = session?.text_draft || null;
  const confirmed = Boolean(session?.text_confirmed);
  const files=useRef(null),replaceRef=useRef(null),[accessCode,setAccessCode]=useState('');
  const references=session?.action_reference_manifest||[],locked=Boolean(busy||pending);
  const complete=Boolean(draft&&session?.assembled_draft_id===draft.draft_id);
  const accessRequired=requiresStudioAccess(health);
  const generateDisabled=locked||health?.configured===false||accessRequired;

  const imageCount = draft ? (session?.image_count_mode === 'CUSTOM' ? session.custom_image_count : draft.recommended_image_count) : 0;
  const estimate = confirmed ? estimateMotherSheetPlan(imageCount, session?.production_mode || 'smart') : null;
  return <div className="vw-creator">
    <div className="vw-journey" aria-label="创作流程">
      {['原文','文字','配图','排版','发布包'].map((label, index) => {
        const current = complete ? 4 : !draft ? 0 : !confirmed ? 1 : 2;
        return <span key={label} className={index < current ? 'done' : index === current ? 'current' : ''}>{index < current ? <Check size={11}/> : index + 1}<b>{label}</b></span>;
      })}
    </div>
    <div className={`vw-provider-state ${health?.configured ? 'ready' : ''}`}>
      <i/><span><strong>{stateLabel(health)}</strong><small>{health?.provider_label || '火山方舟 · 文字先行'}</small><small className="vw-provider-meta">{health?.credential_mode || '凭证模式未读取'} · 文字 {health?.text_model || '未读取'} · 图片 {health?.image_model || '未读取'} · 账本 {health?.image_ledger_attested === true ? 'READY' : health?.image_ledger_attestation_status || '未确认'}</small></span>
      <button type="button" onClick={onRefreshHealth} disabled={!!busy} aria-label="重新检查生成服务"><RefreshCw size={14}/></button>
    </div>
    {accessRequired&&<form className="vw-access-form" onSubmit={async event=>{event.preventDefault();const code=accessCode;setAccessCode('');await onAuthenticate?.(code);}}><label><span>{'\u751f\u6210\u670d\u52a1\u8bbf\u95ee\u7801'}</span><input aria-label={'\u751f\u6210\u670d\u52a1\u8bbf\u95ee\u7801'} type="password" autoComplete="off" value={accessCode} onChange={e=>setAccessCode(e.target.value)} maxLength={256}/></label><button type="submit" disabled={!!busy||!accessCode.trim()}>{'\u8fde\u63a5\u751f\u6210\u670d\u52a1'}</button></form>}
    <section className="vw-creator-section">
      <header><span>01</span><div><strong>写下原文或选题</strong><small>这里只生成文字，确认前图片调用数 = 0</small></div></header>
      <textarea aria-label="原文或选题" rows="6" value={topic} onChange={event => setTopic(event.target.value)} placeholder="例如：为什么真正会休息的人，工作反而更快？也可以直接粘贴一段原文。" disabled={locked}/>
      <details className="vw-writing-requirements"><summary>{'\u5199\u4f5c\u8981\u6c42\uff08\u9009\u586b\uff09'}</summary><textarea aria-label={'\u5199\u4f5c\u8981\u6c42'} rows="3" value={session?.text_requirements||''} onChange={e=>onInput?.({textRequirements:e.target.value})} disabled={locked} placeholder={'\u4f8b\u5982\uff1a\u4fdd\u7559\u539f\u6587\u4e8b\u5b9e\uff0c\u8bed\u6c14\u81ea\u7136\uff0c\u4e0d\u865a\u6784\u4e2a\u4eba\u7ecf\u5386'}/></details>
      <button type="button" className="vw-creator-primary" onClick={onGenerate} disabled={generateDisabled || topic.trim().length < 2}>
        <Sparkles size={15}/>{busy === '生成文字中' ? '正在生成文字…' : draft ? '重新生成文字草稿' : '生成文字草稿'}
      </button>
    </section>
    {draft && <section className="vw-creator-section is-draft">
      <header><span>02</span><div><strong>确认唯一文字</strong><small>3 个标题候选 · 完整正文 · 5 个标签</small></div></header>
      <div className="vw-title-candidates">{draft.titles.map(title => <button type="button" key={title} className={title === draft.selected_title ? 'active' : ''} onClick={() => onChooseTitle(title)} disabled={locked}>{title}</button>)}</div>
      <label><span>最终标题</span><input aria-label="创作最终标题" value={draft.selected_title} onChange={event => onEdit('selected_title', event.target.value)} disabled={locked}/></label>
      <label><span>发布正文</span><textarea aria-label="创作发布正文" rows="9" value={draft.body} onChange={event => onEdit('body', event.target.value)} disabled={locked}/></label>
      <div className="vw-creator-tags"><span>5 个标签</span>{draft.tags.map((tag,index)=><input aria-label={`创作标签 ${index+1}`} key={index} value={tag} onChange={event=>onEdit('tag',event.target.value,index)} disabled={locked}/>)}</div>
      <button type="button" className={`vw-confirm-text ${confirmed ? 'confirmed' : ''}`} onClick={onConfirm} disabled={locked || confirmed}>
        <Check size={15}/>{confirmed ? '文字已确认' : '确认文字，进入配图'}
      </button>
    </section>}
    {recoveryDrafts.length > 0 && <section className="vw-creator-section vw-recovery-list">
      <header><span>↺</span><div><strong>保留的旧配图任务</strong><small>与当前稿分开，不会冻结当前配图设置</small></div></header>
      {recoveryDrafts.map(item=><button type="button" key={item.draft_id} onClick={()=>onOpenRecovery(item.draft_id)} disabled={!!busy}><div><strong>{item.title}</strong><small>{item.protocol_state} · {item.updated_at}</small></div><span>打开恢复稿</span></button>)}
    </section>}
    <section className="vw-creator-section vw-reference-section">
      <header><span>+</span><div><strong>{'\u914d\u56fe\u53c2\u8003'}</strong><small>{'\u6700\u591a3\u5f20\uff1b\u7d20\u6750\u4e0e\u8bf4\u660e\u968f\u4f5c\u54c1\u4fdd\u5b58'}</small></div></header>
      <input ref={files} hidden multiple type="file" accept="image/png,image/jpeg,image/webp" data-testid="reference-upload" onChange={e=>{const list=[...e.target.files];e.target.value='';onAddReferences?.(list,replaceRef.current);replaceRef.current=null;}}/>
      <button type="button" className="vw-reference-drop" disabled={locked||references.length>=3} onClick={()=>{replaceRef.current=null;files.current.multiple=true;files.current.click();}} onDragOver={e=>{e.preventDefault();}} onDrop={e=>{e.preventDefault();if(!locked)onAddReferences?.([...e.dataTransfer.files],null);}}>{'\u62d6\u5165\u53c2\u8003\u56fe\uff0c\u6216\u70b9\u51fb\u4e0a\u4f20'}</button>
      <div className="vw-reference-list">{references.map((item,i)=><figure key={item.media_ref}><img src={referenceUrls[item.media_ref]||''} alt={item.name}/><figcaption>{item.name}</figcaption><div><button type="button" aria-label={`\u66ff\u6362\u53c2\u8003\u56fe ${i+1}`} disabled={locked} onClick={()=>{replaceRef.current=item.media_ref;files.current.multiple=false;files.current.click();}}>{'\u66ff\u6362'}</button><button type="button" aria-label={`\u5220\u9664\u53c2\u8003\u56fe ${i+1}`} disabled={locked} onClick={()=>onRemoveReference?.(item.media_ref)}>{'\u5220\u9664'}</button></div></figure>)}</div>
      <label><span>{'\u53c2\u8003\u8981\u6c42'}</span><textarea aria-label={'\u53c2\u8003\u8981\u6c42'} rows="2" maxLength={1000} value={session?.action_reference_note||''} disabled={locked} onChange={e=>onReferenceNote?.(e.target.value)} placeholder={'\u53ea\u53c2\u8003\u52a8\u4f5c\u548c\u6784\u56fe\uff0c\u4fdd\u7559\u5c0f\u5e08\u59b9\u4eba\u7269\u5f62\u8c61'}/></label>
    </section>
    {confirmed && <section className="vw-creator-section vw-image-plan">
      <header><span>03</span><div><strong>配图与手机排版</strong><small>只有下面的付费按钮会调用图片模型</small></div></header>
      <div className="vw-image-count"><button type="button" className={session.image_count_mode !== 'CUSTOM' ? 'active' : ''} onClick={onAutoImageCount} disabled={locked}>智能判断 · {draft.recommended_image_count} 页</button><select aria-label="配图页数" value={imageCount} onChange={event=>onImageCount(Number(event.target.value))} disabled={locked}>{[1,2,3,4,5,6,7,8].map(value=><option value={value} key={value}>{value} 页</option>)}</select></div>
      <label><span>成品模式</span><select aria-label="配图成品模式" value={session.production_mode || 'smart'} onChange={event=>onProductionMode(event.target.value)} disabled={locked}>{PRODUCTION_MODES.map(mode=><option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>
      <p className="vw-image-estimate">{`\u9884\u8ba1 ${estimate.minMotherSheets===estimate.maxMotherSheets?estimate.minMotherSheets:estimate.minMotherSheets+'-'+estimate.maxMotherSheets} \u5f20\u6bcd\u7248\u56fe\uff0c\u81ea\u52a8\u5207\u5206\u5c01\u9762\u4e3b\u89c6\u89c9\u4e0e\u63d2\u56fe\uff0c\u518d\u6392\u4e3a ${imageCount} \u9875\u53ef\u7f16\u8f91\u4f5c\u54c1\u3002`}</p>
      {pending && <div className="vw-pending-image"><ShieldCheck size={17}/><div><strong>发现可恢复的同稿配图任务</strong><span>{pending.protocol_state} · 已保存恢复点，不会自动继续扣费</span></div><button type="button" onClick={onImageCheck} disabled={!!busy}>检查任务（不生成图片）</button></div>}
      {imageFlow && <p className="vw-flow-state">{imageFlow.phase==='CHECKPOINT_COMMITTED'?'已固定同稿恢复点':imageFlow.phase==='CHECKPOINT_ADVANCED'?'图片步骤已持久化':'配图已完成'}</p>}
      {(!pending || new Set(['READY','PARTIAL']).has(pending.protocol_state)) ? <button type="button" className="vw-paid-image" onClick={onImageRun} disabled={!!busy||health?.configured===false||accessRequired}><ImageIcon size={16}/>{pending?'继续配图（将调用图片模型）':`生成 ${imageCount} 页配图（将调用图片模型）`}</button> : <div className="vw-paid-hold">先检查任务状态；拿到 READY/PARTIAL 回执后才会出现付费继续按钮。</div>}
      <small className="vw-paid-note">手机排版会按内容拆页，最多 8 页，不额外生图。明确付费动作 · 页面加载、保存、刷新、恢复检查都不会自动触发图片模型</small>
    </section>}
    {!draft && <div className="vw-creator-hint"><Type size={17}/><p><strong>先把文字定下来。</strong><span>文字确认前，画面不会因为一次输入而重新生成。你可以放心改标题、正文和标签。</span></p></div>}
  </div>;
}
