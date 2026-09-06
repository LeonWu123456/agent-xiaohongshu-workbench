import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { publishCopy } from '../src/content-engine.mjs';
import { generateContentPackage } from '../src/content-engine.mjs';
import { changePage, replacePageImage, listPageObjects, importEditableContent, createBlankContent, addContentPage, duplicateContentPage, deleteContentPage, reorderContentPage, clampPageIndex } from '../src/visual-workbench/model.mjs';
test('visual editor changes real content, keeps unrelated pages and original immutable',()=>{
 const before=generateContentPackage({topic:'生活有自己的节奏'});
 const after=changePage(before,0,{title:'改后的标题'});
 assert.equal(after.pages[0].title,'改后的标题');assert.notEqual(before.pages[0].title,'改后的标题');
 assert.deepEqual(after.pages[1],before.pages[1]);
});
test('replacement preserves original page metadata and targets only the selected image',()=>{
 const c=generateContentPackage({topic:'生活'}),p=c.pages[0];
 const changed=replacePageImage(p,'hero','data:image/png;base64,AA==');
 assert.equal(changed.image_style.src,'data:image/png;base64,AA==');assert.equal(changed.title,p.title);
 assert.notEqual(changed.image_style.src,p.image_style.src);
});
test('legacy package imports as editable content, invalid input fails',()=>{
 const c=generateContentPackage({topic:'原版草稿'}); const next=importEditableContent(c);
 assert.equal(next.pages[0].title,c.pages[0].title);assert.throws(()=>importEditableContent({pages:[]}));
});
test('object list refers to actual canvas IDs, not fabricated arbitrary layers',()=>{
 const c=generateContentPackage({topic:'生活'});const ids=listPageObjects(c.pages[0],0).map(x=>x.id);
 assert.ok(ids.includes('title-block'));assert.ok(ids.includes('hero-image'));
});
import {createVisualStorage,STORAGE_KEYS} from '../src/visual-workbench/storage.mjs';
import {createMediaAssetStore,createMemoryMediaDatabase} from '../src/media-asset-store.mjs';
import {createDemo} from '../src/visual-workbench/model.mjs';
function memoryStorage(){const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),data};}
function adapter(storage){return createVisualStorage({storage,mediaStore:createMediaAssetStore({database:createMemoryMediaDatabase()}),lockManager:{request:async(_name,_options,callback)=>callback()}});}
test('save uses existing v3 schema/key and survives fresh adapter reload',async()=>{
 const storage=memoryStorage(),a=adapter(storage);assert.equal(await a.load(),null);
 const saved=await a.save(createDemo());assert.equal(saved.receipt.ok,true);assert.equal(storage.data.size,1);assert.ok(storage.getItem(STORAGE_KEYS.envelopeV3));
 const b=adapter(storage),loaded=await b.load();assert.equal(loaded.pages[0].title,'给生活，留一点空白');assert.equal(loaded.pages.length,3);
 a.dispose();b.dispose();
});
test('concurrent external edit denies stale save instead of overwriting',async()=>{
 const storage=memoryStorage(),a=adapter(storage);await a.load();await a.save(createDemo());
 const b=adapter(storage);const c=await b.load();await a.save(changePage(c,0,{title:'另一个窗口已更新'}));
 await assert.rejects(()=>b.save(changePage(c,0,{title:'过期窗口的修改'})),/另一个标签页/);
 assert.equal(JSON.parse(storage.getItem(STORAGE_KEYS.envelopeV3)).drafts[0].content_package.pages[0].title,'另一个窗口已更新');
});
test('storage write error is not reported as a saved document',async()=>{
 const storage=memoryStorage(),a=adapter(storage);await a.load();storage.setItem=()=>{throw new Error('QuotaExceeded');};
 await assert.rejects(()=>a.save(createDemo()),/保存失败/);assert.equal(storage.data.size,0);
});
test('import creates a new editable draft and preserves the existing draft',async()=>{
 const storage=memoryStorage(),a=adapter(storage);await a.load();await a.save(createDemo());
 const imported=changePage(createDemo(),0,{title:'旧格式导入测试'});
 const result=await a.importFile(JSON.stringify(imported));assert.equal(result.workspace.drafts.length,2);
 assert.equal(result.content.pages[0].title,'旧格式导入测试');assert.equal(result.workspace.drafts[0].content_package.pages[0].title,'给生活，留一点空白');
});


test('direct production editor has no edit/move mode switch and exposes direct handles',async()=>{
 const [main,editor]=await Promise.all([readFile(new URL('../src/visual-workbench/main.jsx',import.meta.url),'utf8'),readFile(new URL('../src/HtmlPageEditor.jsx',import.meta.url),'utf8')]);
 assert.match(main,/interactionMode="direct"/);assert.doesNotMatch(main,/setMode\(|改字 \/ 取景|移动布局/);
 assert.match(editor,/html-editor-direct-handle is-move/);assert.match(editor,/html-editor-direct-handle is-resize/);
});

test('page management adds a blank page, duplicates, reorders and never deletes the last page',()=>{
 let content=createBlankContent();assert.equal(content.visible_pages,1);
 content=addContentPage(content,0);assert.equal(content.visible_pages,2);assert.equal(content.pages[1].title,'点击输入标题');assert.equal(content.pages[1].visual,'none');assert.equal(listPageObjects(content.pages[1],1).some(x=>x.kind==='image'),false);
 content=duplicateContentPage(content,0);assert.equal(content.visible_pages,3);
 content=reorderContentPage(content,0,2);assert.equal(content.pages[2].title,'未命名作品');
 content=deleteContentPage(content,1);assert.equal(content.visible_pages,2);
 const one=createBlankContent();assert.throws(()=>deleteContentPage(one,0),/page cannot be deleted/);
});

test('workspace v3 library creates, duplicates and opens drafts without a second store',async()=>{
 const storage=memoryStorage(),a=adapter(storage);await a.load();
 await a.createDraft(createBlankContent());assert.equal(a.drafts().length,1);const first=a.drafts()[0].draft_id;
 const duplicated=await a.duplicateActiveDraft();assert.equal(duplicated.workspace.drafts.length,2);assert.equal(a.drafts().filter(x=>x.active).length,1);
 await a.activateDraft(first);assert.equal(a.drafts().find(x=>x.active).draft_id,first);assert.equal(storage.data.size,1);
 a.dispose();
});


test('blank page image absence survives schema round-trip and upload re-enables the hero image',()=>{
 const content=addContentPage(createBlankContent(),0);const roundtrip=importEditableContent(content);const page=roundtrip.pages[1];
 assert.equal(page.visual,'none');assert.equal(listPageObjects(page,1).some(x=>x.kind==='image'),false);
 const withImage=replacePageImage(page,'hero','/assets/xiaoshimei-character-full.png');assert.equal(withImage.visual,'character');assert.ok(listPageObjects(withImage,1).some(x=>x.id==='hero-image'));
});

test('page index clamps after undo, delete or any page-count contraction',()=>{
 assert.equal(clampPageIndex({visible_pages:1,pages:[{}]},1),0);assert.equal(clampPageIndex({visible_pages:4,pages:[{},{},{},{}]},9),3);assert.equal(clampPageIndex({visible_pages:4,pages:[{},{},{},{}]},2),2);
});


test('blank draft never inherits demo publish copy',()=>{
 const blank=createBlankContent();const copy=publishCopy(blank);
 assert.equal(blank.body,'');assert.deepEqual(blank.tags,['','','','','']);
 assert.doesNotMatch(copy,/忙起来时|古法养生|传统文化|自我照顾/);
});

test('legacy flow retains its scale floor while free canvas exposes independent pixel geometry',async()=>{
 const [main,editor]=await Promise.all([readFile(new URL('../src/visual-workbench/main.jsx',import.meta.url),'utf8'),readFile(new URL('../src/HtmlPageEditor.jsx',import.meta.url),'utf8')]);
 assert.match(main,/freeSelected.width\*10.8/);assert.match(main,/freeSelected.font_size/);
 assert.match(editor,/Math\.max\(\.72, drag\.start\.scale/);assert.match(editor,/Math\.max\(\.72, scale \* fitFactor\)/);
 assert.doesNotMatch(editor,/Math\.max\(\.65, (?:drag\.start\.scale|scale \* fitFactor)/);
});


test('draft display name is independent of content and survives save, reload and copy',async()=>{
 const storage=memoryStorage(),a=adapter(storage);await a.load();await a.createDraft(createBlankContent());
 const original=structuredClone(a.activeRecord().content_package),first=a.activeRecord().draft_id;
 await a.renameActiveDraft('我的第一份作品');
 assert.equal(a.drafts()[0].title,'我的第一份作品');assert.deepEqual(a.activeRecord().content_package,original);
 await a.save(changePage(original,0,{title:'封面改字不改变作品名'}));
 const b=adapter(storage);await b.load();assert.equal(b.activeRecord().display_name,'我的第一份作品');
 await b.duplicateActiveDraft();assert.notEqual(b.activeRecord().draft_id,first);
 assert.match(b.activeRecord().display_name,/副本/);await b.renameActiveDraft('独立副本');
 await b.activateDraft(first);assert.equal(b.activeRecord().display_name,'我的第一份作品');assert.equal(storage.data.size,1);
 a.dispose();b.dispose();
});

test('rename rejects blank names and stale writes without altering saved content',async()=>{
 const storage=memoryStorage(),a=adapter(storage);await a.load();await a.createDraft(createBlankContent());
 await assert.rejects(()=>a.renameActiveDraft('   '),/名称/);await assert.rejects(()=>a.renameActiveDraft('长'.repeat(121)),/名称/);
 const b=adapter(storage);await b.load();await a.renameActiveDraft('新窗口名称');
 await assert.rejects(()=>b.renameActiveDraft('旧窗口名称'),/另一个标签页/);
 const c=adapter(storage);await c.load();assert.equal(c.activeRecord().display_name,'新窗口名称');
 a.dispose();b.dispose();c.dispose();
});

test('v3 backup restores the display name and old nameless records still load',async()=>{
 const storage=memoryStorage(),a=adapter(storage);await a.load();await a.createDraft(createBlankContent());
 assert.equal(a.activeRecord().display_name,undefined);await a.renameActiveDraft('备份中的作品名');
 const backup=await a.backup(),b=adapter(memoryStorage());await b.load();await b.importFile(JSON.stringify(backup));
 assert.equal(b.activeRecord().display_name,'备份中的作品名');assert.equal(b.activeRecord().content_package.selectedTitle,'未命名作品');
 a.dispose();b.dispose();
});

test('direct gesture cancellation restores transient DOM and empty edits commit visible fallbacks',async()=>{
 const editor=await readFile(new URL('../src/HtmlPageEditor.jsx',import.meta.url),'utf8');
 assert.match(editor,/if \(!commit\) \{\s*drag\.target\.style\.setProperty\("--object-x", `\$\{drag\.start\.x\}cqw`\);\s*drag\.target\.style\.setProperty\("--object-y", `\$\{drag\.start\.y\}cqh`\);/s);
 assert.match(editor,/if \(!commit\) drag\.target\.style\.setProperty\("--object-scale", drag\.start\.scale\);/);
 assert.match(editor,/captureTarget: event\.currentTarget/);
 assert.match(editor,/onLostPointerCapture=\{\(event\)=>finishObjectMove\(event,objectId,false\)\}/);
 assert.match(editor,/const next = cleaned \|\| String\(emptyFallback \|\| "点击输入文字"\)\.trim\(\);/);
 assert.match(editor,/emptyFallback="点击输入标题"/);
 assert.match(editor,/emptyFallback="点击输入正文"/);
 assert.doesNotMatch(editor,/if \(next && next !== String\(value \|\| ""\)\.trim\(\)\) onCommit\(next\)/);
});


test('direct edges move modules, corners resize and image wheel zoom is local',async()=>{
 const editor=await readFile(new URL('../src/HtmlPageEditor.jsx',import.meta.url),'utf8');
 assert.match(editor,/\["top","right","bottom","left"\]\.map\(edge/);
 assert.match(editor,/\["nw","ne","se","sw"\]\.map\(corner/);
 assert.match(editor,/onWheel=\{renderOnly \? undefined : \(event\) => \{/);
 assert.match(editor,/onEdit\?\.\(id,\{zoom:Math\.min\(1\.8,Math\.max\(1,edit\.zoom\+delta\)\)\}\)/);
 assert.match(editor,/signX, signY/);
});

test('narrow workbench exposes the selected library or page panel without hiding the rail',async()=>{
 const [source,css]=await Promise.all([readFile(new URL('../src/visual-workbench/main.jsx',import.meta.url),'utf8'),readFile(new URL('../src/visual-workbench/workbench.css',import.meta.url),'utf8')]);
 assert.match(source,/narrowPanelOpen/);
 assert.match(source,/vw-panel-open/);
 assert.match(source,/className="vw-panel-close"/);
 assert.match(css,/\.vw-body\.vw-panel-open \.vw-left\{display:flex/);
 assert.match(css,/\.vw-body\.vw-panel-open \.vw-workspace,\.vw-body\.vw-panel-open \.vw-inspector\{display:none\}/);
});


test('free canvas geometry and typography survive the canonical HTML normalization',async()=>{
 const {normalizeHtmlState}=await import('../src/html-layout.mjs');
 const page=createBlankContent().pages[0];
 const state=normalizeHtmlState({...normalizeHtmlState(null,page),free_objects:[{id:'title-block',kind:'text',binding:'title',x:65,y:70,width:25,height:10,rotation:17,font_size:96,font_family:'songti'}]},page);
 assert.equal(state.free_objects[0].x,65);assert.equal(state.free_objects[0].font_size,96);assert.equal(state.free_objects[0].width,25);assert.equal(state.free_objects[0].rotation,17);
 const restored=importEditableContent({...createBlankContent(),pages:[{...page,html_state:state}]});assert.deepEqual(restored.pages[0].html_state.free_objects,state.free_objects);
});

test('workbench removes nonfunctional intro cards and uses the existing character avatar',async()=>{
 const main=await readFile(new URL('../src/visual-workbench/main.jsx',import.meta.url),'utf8');
 assert.doesNotMatch(main,/className="vw-stage-intro"|className="vw-inspector-note"/);
 assert.match(main,/className="vw-brand-avatar"/);
});


test('Sprint 2 smart composition materializes every page and preserves text and independent image sources',async()=>{
 const {composeEditableContent}=await import('../src/visual-workbench/model.mjs');assert.equal(typeof composeEditableContent,'function');
 const source=createBlankContent();source.pages[0].body='A body that must remain editable.';source.pages[0].visual='character';source.pages[0].image_style.src='/assets/xiaoshimei-character-full.png';
 const result=composeEditableContent(source);assert.equal(result.body,source.body);assert.equal(source.pages[0].html_state?.free_objects,undefined);
 const objects=result.pages[0].html_state.free_objects;assert.ok(objects.some(o=>o.binding==='body'));assert.ok(objects.some(o=>o.kind==='image'&&o.binding==='hero'));assert.ok(objects.some(o=>o.binding==='title'));
 const custom={id:'custom-copy',kind:'text',text:'Manual copy is not discarded',x:2,y:2,width:30,height:10,font_size:36};result.pages[0].html_state.free_objects.push(custom);
 const reflow=composeEditableContent(result,{force:true});assert.ok(reflow.pages[0].html_state.free_objects.some(o=>o.id==='custom-copy'&&o.text===custom.text));assert.deepEqual(composeEditableContent(reflow),reflow);
});


test('legacy visible geometry materialization waits for a measurable page and is not a user edit',async()=>{
 const editor=await readFile(new URL('../src/HtmlPageEditor.jsx',import.meta.url),'utf8');const main=await readFile(new URL('../src/visual-workbench/main.jsx',import.meta.url),'utf8');
 assert.match(editor,/rect.width<=0\|\|rect.height<=0/);assert.match(editor,/new ResizeObserver\(convert\)/);assert.match(editor,/\{materialize:true\}/);assert.match(main,/meta\?\.materialize\?setContent/);
});
test('paragraph font and spacing survive free-object schema and persistence',async()=>{
 const {normalizeHtmlState}=await import('../src/html-layout.mjs');const page=createBlankContent().pages[0];
 const state=normalizeHtmlState({free_objects:[{id:'body-block',kind:'text',binding:'body',font_size:42.66,line_height:1.6,paragraph_gap:24,x:10,y:20,width:70,height:20}]},page);
 assert.equal(state.free_objects[0].paragraph_gap,24);assert.equal(state.free_objects[0].font_size,42.66);
 const content=importEditableContent({...createBlankContent(),pages:[{...page,html_state:state}]});assert.equal(content.pages[0].html_state.free_objects[0].paragraph_gap,24);
});


test('editable browser descendants are not React-managed paragraph nodes',async()=>{
 const editor=await readFile(new URL('../src/HtmlPageEditor.jsx',import.meta.url),'utf8');assert.match(editor,/ref=\{element=>syncFreeText\(element,item,page,editing===item.id\)\}/);assert.match(editor,/if\(!element\|\|isEditing\)return/);assert.match(editor,/element.replaceChildren/);assert.doesNotMatch(editor,/bodyParagraphs\(freeObjectText\(page,item\)\)\.map\(\(text,i\)=><div/);
});


test('mobile editorial reflow keeps body readable and splits dense system panels, without changing copy or image sources',async()=>{
 const {composeEditableContent}=await import('../src/visual-workbench/model.mjs');
 const base=createBlankContent();base.pages[0].page_role='method';base.pages[0].title='Three calm moments';
 base.pages[0].info_panels=[0,1,2].map(i=>({id:'p'+i,title:'Moment '+i,body:'Keep this sentence exactly '+i,image_style:{src:'/assets/xiaoshimei-character-full.png'},visual_action:'calm'}));
 const before=structuredClone(base),result=composeEditableContent(base,{force:true});
 assert.equal(result.pages.length,3);assert.equal(result.visible_pages,3);assert.equal(result.body,before.body);assert.deepEqual(base,before);
 assert.deepEqual(result.pages.map(p=>p.body),before.pages[0].info_panels.map(x=>x.body));
 for(const p of result.pages){const o=p.html_state.free_objects;assert.ok(o.filter(x=>x.kind==='text'&&x.binding!=='eyebrow').every(x=>x.font_size>=54));assert.equal(o.filter(x=>x.kind==='image').length,1);assert.ok(o.find(x=>x.kind==='image').height>=30);}
 assert.equal(composeEditableContent(result,{force:true}).pages.length,3);assert.equal(importEditableContent(result).pages.length,3);
});

test('mobile reflow refuses overflow rather than shrinking copy or silently discarding custom objects',async()=>{
 const {composeEditableContent}=await import('../src/visual-workbench/model.mjs');const c=createBlankContent();c.pages[0].body='Long reading copy. '.repeat(600);const before=structuredClone(c);
 assert.throws(()=>composeEditableContent(c,{force:true}),/\u62c6\u5206|\u62c6\u9875/);assert.deepEqual(c,before);
});


test('mobile page cap is atomic, and a single-page reflow never changes untouched custom pages',async()=>{
 const {composeEditableContent}=await import('../src/visual-workbench/model.mjs');const one=createBlankContent();const p=one.pages[0];const dense={...p,info_panels:[0,1,2].map(i=>({id:'p'+i,title:'Title '+i,body:'Exact '+i,image_style:{src:'/assets/xiaoshimei-character-full.png'}}))};
 const full={...one,pages:Array.from({length:4},()=>structuredClone(dense)),visible_pages:4},frozen=structuredClone(full);assert.throws(()=>composeEditableContent(full,{force:true}),e=>e.code==='MOBILE_PAGE_LIMIT');assert.deepEqual(full,frozen);
 const partial={...one,pages:[dense,p],visible_pages:2};const output=composeEditableContent(partial,{force:true,pageIndex:0});assert.equal(output.pages.length,4);assert.deepEqual(output.pages[3],p);
});


test('mobile cover continuation preserves the complete opening text across pages and reflow stays stable',async()=>{
 const {composeEditableContent}=await import('../src/visual-workbench/model.mjs');const c=createBlankContent();c.pages[0].body='A quiet opening. '+('Keep every original word in the next reading page.');c.pages[0].visual='character';c.pages[0].image_style.src='/assets/xiaoshimei-character-full.png';
 const p={...structuredClone(c.pages[0]),body:'Context stays too.',page_role:'method',info_panels:[0,1,2].map(i=>({title:'Step '+i,body:'Original step '+i,image_style:{src:'/assets/xiaoshimei-character-full.png'}}))};c.pages.push(p);c.visible_pages=2;
 const result=composeEditableContent(c,{force:true});assert.equal(result.pages.length,4);const again=composeEditableContent(result,{force:true});assert.equal(again.pages.length,4);assert.deepEqual(result.pages.map(p=>p.body),again.pages.map(p=>p.body));
});


test('mobile reflow does not move a panel scene body into another source page',async()=>{
 const {composeEditableContent}=await import('../src/visual-workbench/model.mjs');const c=createBlankContent();
 const makePage=n=>({...structuredClone(c.pages[0]),page_role:'method',title:'Method '+n,body:'Page context '+n,info_panels:[0,1,2].map(i=>({id:'p'+i,title:'Scene '+n+i,body:'First scene sentence。'+('Exact explanation '+n+i+' ').repeat(4),image_style:{src:'/assets/xiaoshimei-character-full.png'}}))});
 c.pages=[makePage(0),makePage(1)];c.visible_pages=2;const result=composeEditableContent(c,{force:true});
 assert.equal(result.pages[0].body,c.pages[0].info_panels[0].body);assert.equal(result.pages[3].body,c.pages[1].info_panels[0].body);
 assert.ok(result.pages.every(p=>!p.html_state.free_objects.some(o=>o.id==='opening-continuation')));
});
test('short text-only panel pages keep fitting instead of manufacturing a ninth page',async()=>{
 const {composeEditableContent}=await import('../src/visual-workbench/model.mjs');const c=createBlankContent();
 const p={...c.pages[0],title:'Three short notes',body:'',info_panels:[0,1,2].map(i=>({id:'p'+i,title:'Note '+i,body:'Keep '+i,image_style:{src:'',hidden:true}}))};c.pages=[p,structuredClone(p),structuredClone(p)];c.visible_pages=3;
 const before=structuredClone(c),result=composeEditableContent(c,{force:true});assert.equal(result.pages.length,3);assert.deepEqual(c,before);
 for(const page of result.pages)assert.equal(page.info_panels.length,3);
});


test('browser-owned paragraph serialization preserves blank lines independent of visual margins',async()=>{
 const {readEditablePlainText}=await import('../src/html-layout.mjs');
 const txt=nodeValue=>({nodeType:3,nodeValue}),el=(tagName,...childNodes)=>({nodeType:1,tagName,childNodes});
 assert.equal(readEditablePlainText(el('DIV',txt('a'),el('DIV',el('BR')),el('DIV',txt('b')),el('DIV',el('BR')),el('DIV',txt('c')))),'a\n\nb\n\nc');
 for(const text of ['a\nb','a\n\nb','a\n\n\nb','\na\n','', 'a\n\n'])assert.equal(readEditablePlainText(el('DIV',txt(text))),text);
 assert.equal(readEditablePlainText(el('DIV',el('DIV',txt('a')),el('DIV',el('BR')))),'a\n');
 assert.equal(readEditablePlainText(el('DIV',txt('a'),el('SPAN',txt('b')),el('BR'),txt('c'))),'ab\nc');
});


test('split scenes retain their own action identity rather than the parent page action',async()=>{
 const {composeEditableContent}=await import('../src/visual-workbench/model.mjs');const c=createBlankContent();c.pages[0]={...c.pages[0],visual_action:'parent action',image_prompt:'parent image',info_panels:[0,1,2].map(i=>({id:'p'+i,title:'Scene '+i,body:'Same scene copy.',visual_action:'unique action '+i,image_prompt:'unique scene '+i,image_style:{src:'/assets/xiaoshimei-character-full.png'}}))};
 const result=composeEditableContent(c,{force:true});assert.equal(result.pages.length,3);
 result.pages.forEach((page,i)=>{assert.equal(page.visual_action,'unique action '+i);assert.equal(page.image_prompt,'unique scene '+i);});
});


test('interactive canvas does not defer manipulation controls past early edits',async()=>{
 const {readFile}=await import('node:fs/promises');const source=await readFile(new URL('../src/HtmlPageEditor.jsx',import.meta.url),'utf8');
 assert.match(source,/import Moveable from "react-moveable"/);assert.equal(source.includes('const Moveable = React.lazy('),false);
});


test('confirmed copy audit sees visible text, not merely retained publication body or image metadata',async()=>{
 const api=await import('../src/visual-workbench/model.mjs');assert.equal(typeof api.confirmedCopyCoverage,'function');
 const original=api.createDemo();const missing='先找一处能听见雨声的位置坐下，把空间里多余的声响关掉，让周围只剩下窗外雨落的声音。';
 original.body=[original.pages[0].body,original.pages[1].body,missing,original.pages[2].body].join('\n');original.pages[1].visual_action=missing;
 const before=api.composeEditableContent(original);assert.ok(api.confirmedCopyCoverage(before).missing.some(x=>x.text===missing));
 const untouched=structuredClone(before),fixed=api.reconcileConfirmedCopy(before);assert.deepEqual(before,untouched);assert.equal(fixed.body,before.body);assert.deepEqual(api.confirmedCopyCoverage(fixed).missing,[]);
 const {freeObjectText}=await import('../src/html-layout.mjs');const text=c=>c.pages.slice(0,c.visible_pages).flatMap(p=>p.html_state.free_objects.filter(o=>o.kind==='text').map(o=>freeObjectText(p,o))).join('\n');
 assert.ok(text(fixed).includes(missing));for(const page of before.pages){assert.ok(text(fixed).includes(page.title));assert.ok(text(fixed).includes(page.body));}
 assert.deepEqual(api.reconcileConfirmedCopy(fixed),fixed);
});

test('confirmed copy repair fails atomically rather than shrinking text or exceeding eight pages',async()=>{
 const api=await import('../src/visual-workbench/model.mjs');assert.equal(typeof api.reconcileConfirmedCopy,'function');const source=api.createDemo();
 source.pages=Array.from({length:8},(_,i)=>({...structuredClone(source.pages[0]),title:'Page '+i,body:'A'.repeat(150),html_state:undefined}));source.visible_pages=8;source.body='B'.repeat(2000);const frozen=structuredClone(source);
 assert.throws(()=>api.reconcileConfirmedCopy(source),error=>['CONFIRMED_COPY_PAGE_LIMIT','EDITABLE_LAYOUT_NEEDS_SPLIT'].includes(error.code));assert.deepEqual(source,frozen);
});

test('source coverage does not count invisible text and ordinary reflow never silently restores deleted copy',async()=>{
 const api=await import('../src/visual-workbench/model.mjs');assert.equal(typeof api.confirmedCopyCoverage,'function');const source=api.composeEditableContent(api.createDemo());source.body='用户主动删掉的这一句。';source.pages[0].html_state.free_objects.push({id:'invisible-copy',kind:'text',text:source.body,x:0,y:0,width:60,height:12,font_size:54,font_family:'pingfang',line_height:1.5,opacity:0});
 assert.equal(api.confirmedCopyCoverage(source).missing.length,1);const reflow=api.composeEditableContent(source,{force:true});assert.equal(api.confirmedCopyCoverage(reflow).missing.length,1);
});


test('coverage preserves decimal and ratio meaning instead of matching collapsed numbers',async()=>{
 const api=await import('../src/visual-workbench/model.mjs');
 for(const [source,wrong] of [['等待1.5分钟。','等待15分钟。'],['比例为2/3。','比例为23。']]){
  const c=api.createDemo();c.body=source;c.pages=c.pages.slice(0,1);c.visible_pages=1;c.pages[0].body=wrong;c.pages[0].title='数值说明';c.pages[0].eyebrow='说明';assert.equal(api.confirmedCopyCoverage(api.composeEditableContent(c)).missing.length,1);
 }
});

test('filling a short missing sentence never repositions previously editable objects',async()=>{
 const api=await import('../src/visual-workbench/model.mjs');const c=api.composeEditableContent(api.createDemo());
 c.body=c.pages.map(p=>p.body).join('\n')+'\n新增的一句。';const image=c.pages[0].html_state.free_objects.find(o=>o.kind==='image');image.rotation=8;image.x=11;
 const before=structuredClone(c),after=api.reconcileConfirmedCopy(c);assert.deepEqual(c,before);
 for(const page of before.pages){const found=after.pages.find(p=>p.title===page.title);assert.deepEqual(found.html_state,page.html_state);assert.equal(found.body,page.body);}
 assert.equal(api.confirmedCopyCoverage(after).missing.length,0);
});


test('confirmed sentences cannot be matched inside a negation, longer number or compatibility numeral',async()=>{
 const api=await import('../src/visual-workbench/model.mjs');
 for(const [source,wrong] of [['需要加糖。','不需要加糖。'],['1.5分钟。','11.5分钟。'],['计算结果是2³。','计算结果是23。']]){
  const c=api.createDemo();c.body=source;c.pages=c.pages.slice(0,1);c.visible_pages=1;c.pages[0].body=wrong;c.pages[0].title='说明';c.pages[0].eyebrow='说明';assert.equal(api.confirmedCopyCoverage(api.composeEditableContent(c)).missing.length,1);
 }
});

test('missing opening sentences precede their following anchor for both new and already editable work',async()=>{
 const api=await import('../src/visual-workbench/model.mjs');
 for(const editable of [false,true]){
  let c=api.createDemo();c.pages=c.pages.slice(0,1);c.visible_pages=1;c.pages[0].body='再揉面。';c.body='先洗手。备好面粉。再揉面。';if(editable)c=api.composeEditableContent(c);
  const {freeObjectText}=await import('../src/html-layout.mjs');const fixed=api.reconcileConfirmedCopy(c);const all=fixed.pages.flatMap(p=>p.html_state.free_objects.filter(o=>o.kind==='text'&&o.binding!=='title'&&o.binding!=='eyebrow').map(o=>freeObjectText(p,o))).join('\n');
  assert.ok(all.indexOf('先洗手。')<all.indexOf('备好面粉。'));assert.ok(all.indexOf('备好面粉。')<all.indexOf('再揉面。'));assert.deepEqual(api.confirmedCopyCoverage(fixed).missing,[]);
 }
});


test('source gap inside one already arranged paragraph refuses atomically instead of shuffling its order',async()=>{
 const api=await import('../src/visual-workbench/model.mjs');let c=api.createDemo();c.pages=c.pages.slice(0,1);c.visible_pages=1;c.pages[0].body='先洗手。再揉面。';c.body='先洗手。备好面粉。再揉面。';c=api.composeEditableContent(c);const before=structuredClone(c);
 assert.throws(()=>api.reconcileConfirmedCopy(c),e=>e.code==='CONFIRMED_COPY_SEQUENCE_CONFLICT');assert.deepEqual(c,before);
});


test('free-object text owns letter spacing so editor chrome cannot change exported wrapping',async()=>{
 const source=await readFile(new URL('../src/HtmlPageEditor.jsx',import.meta.url),'utf8');const css=source.slice(source.indexOf('function freeCss('),source.indexOf('// The browser owns editable descendants'));
 assert.match(css,/letterSpacing:0/);
});


test('derived page headings never count as proof that a missing body instruction was delivered',async()=>{
 const api=await import('../src/visual-workbench/model.mjs');const {freeObjectText}=await import('../src/html-layout.mjs');let c=api.createDemo();c.pages=c.pages.slice(0,1);c.visible_pages=1;c.pages[0].body='再揉面。';c.body='先洗手。洗手。再揉面。';c=api.composeEditableContent(c);const fixed=api.reconcileConfirmedCopy(c);
 const text=fixed.pages.flatMap(p=>p.html_state.free_objects.filter(o=>o.kind==='text'&&!['title','eyebrow'].includes(o.binding)).map(o=>freeObjectText(p,o))).join('\n');assert.ok(text.includes('先洗手。\n洗手。'));assert.equal(c.body,'先洗手。洗手。再揉面。');assert.ok(text.indexOf('先洗手。')<text.indexOf('再揉面。'));assert.deepEqual(api.confirmedCopyCoverage(fixed).missing,[]);
 const headingOnly=structuredClone(c);headingOnly.pages[0].title='先洗手。';assert.ok(api.confirmedCopyCoverage(headingOnly).missing.some(x=>x.text==='先洗手。'));
});


test('repeated source actions each require their own ordered visible occurrence',async()=>{
 const api=await import('../src/visual-workbench/model.mjs');const {freeObjectText}=await import('../src/html-layout.mjs');let c=api.createDemo();c.pages=c.pages.slice(0,2);c.visible_pages=2;c.pages[0].body='搅拌。';c.pages[1].body='装盘。';c.body='搅拌。静置。搅拌。装盘。';c=api.composeEditableContent(c);
 const audit=api.confirmedCopyCoverage(c);assert.equal(audit.checked_segments,4);assert.deepEqual(audit.missing.map(x=>x.text),['静置。','搅拌。']);
 const fixed=api.reconcileConfirmedCopy(c);const text=fixed.pages.flatMap(p=>p.html_state.free_objects.filter(o=>o.kind==='text'&&!['title','eyebrow'].includes(o.binding)).map(o=>freeObjectText(p,o))).join('');assert.equal(text.replace(/\s/g,''),c.body);assert.deepEqual(api.confirmedCopyCoverage(fixed).missing,[]);assert.deepEqual(api.reconcileConfirmedCopy(fixed),fixed);
});


test('overflowing parent context flows only across its own split scenes without shrinking or dropping text',async()=>{
 const {composeEditableContent}=await import('../src/visual-workbench/model.mjs');
 const c=createBlankContent(),page=c.pages[0];page.title='三个阅读步骤';page.eyebrow='阅读练习';page.page_role='method';
 const parts=[0,1,2].map(i=>`第${i+1}步，`+'这一段原始说明必须完整保留，不可以把正文缩小或者删掉。'.repeat(2));page.body=parts.join('\n');
 page.info_panels=[0,1,2].map(i=>({id:'p'+i,title:'原来场景'+i,body:'该场景的短说明不能被换走。',visual_action:'scene action '+i,image_prompt:'scene image '+i,image_style:{src:'/assets/xiaoshimei-character-full.png'}}));
 const before=structuredClone(c),out=composeEditableContent(c,{force:true});assert.equal(out.pages.length,3);assert.deepEqual(c,before);
 const contexts=out.pages.flatMap(p=>p.html_state.free_objects.filter(o=>o.id==='context-copy').map(o=>o.text));assert.equal(contexts.join(''),page.body);
 out.pages.forEach((p,i)=>{assert.equal(p.body,page.info_panels[i].body);assert.equal(p.visual_action,page.info_panels[i].visual_action);assert.equal(p.image_style.src,page.info_panels[i].image_style.src);assert.ok(p.html_state.free_objects.filter(o=>o.kind==='text').every(o=>o.font_size>=42));assert.ok(p.html_state.free_objects.find(o=>o.kind==='image').height>=25);});
 assert.deepEqual(composeEditableContent(out,{force:true}).pages.map(p=>p.html_state.free_objects.filter(o=>o.id==='context-copy').map(o=>o.text)),out.pages.map(p=>p.html_state.free_objects.filter(o=>o.id==='context-copy').map(o=>o.text)));
 const tooLong=structuredClone(c);tooLong.pages[0].body='无法拆开的长句'.repeat(800);const untouched=structuredClone(tooLong);assert.throws(()=>composeEditableContent(tooLong,{force:true}),e=>e.code==='EDITABLE_LAYOUT_NEEDS_SPLIT');assert.deepEqual(tooLong,untouched);
});

test('confirmed-copy tail can fit a newly composed scene but never repacks an existing manual page',async()=>{
 const {composeEditableContent,reconcileConfirmedCopy,confirmedCopyCoverage}=await import('../src/visual-workbench/model.mjs');
 const c=createBlankContent();c.pages[0].title='保留阅读顺序';c.pages[0].eyebrow='短说明';c.pages[0].body='第一段已经显示在画面里。';c.pages[0].visual='character';c.pages[0].image_style={...c.pages[0].image_style,src:'/assets/xiaoshimei-character-full.png',hidden:false};c.body=c.pages[0].body+'\n下一段需要作为独立文字保留下来。';
 const before=structuredClone(c),fresh=reconcileConfirmedCopy(c);assert.equal(fresh.pages.length,1);assert.equal(fresh.pages[0].body,c.pages[0].body);assert.equal(fresh.body,c.body);assert.deepEqual(c,before);assert.deepEqual(confirmedCopyCoverage(fresh).missing,[]);assert.deepEqual(reconcileConfirmedCopy(fresh),fresh);
 const manual=composeEditableContent(c);manual.pages[0].html_state.free_objects.find(o=>o.kind==='image').x=8;const original=structuredClone(manual);const repaired=reconcileConfirmedCopy(manual);assert.equal(repaired.pages.length,2);assert.deepEqual(repaired.pages[0],original.pages[0]);assert.deepEqual(manual,original);assert.deepEqual(confirmedCopyCoverage(repaired).missing,[]);
});



test('parent context packing does not reject a feasible uneven four-one-one sentence distribution',async()=>{
 const {composeEditableContent}=await import('../src/visual-workbench/model.mjs');const c=createBlankContent(),p=c.pages[0];
 Object.assign(p,{title:'步骤',eyebrow:'说明',page_role:'method',body:'',info_panels:[0,1,2].map(i=>({title:'场景'+i,body:'说明。',image_style:{src:'/assets/x.png'}}))});
 const chunks=[...Array(4).fill('短'.repeat(5)+'。'),'长'.repeat(65)+'。','尾'.repeat(65)+'。'];p.body=chunks.join('');
 const before=structuredClone(c),out=composeEditableContent(c);assert.equal(out.pages.length,3);assert.deepEqual(c,before);
 assert.equal(out.pages.flatMap(p=>p.html_state.free_objects.filter(o=>o.id==='context-copy').map(o=>o.text)).join(''),p.body);
});


test('crop is nondestructive bounded source geometry and survives normalized save',async()=>{
 const api=await import('../src/html-layout.mjs');assert.equal(typeof api.normalizeSourceCrop,'function');
 assert.deepEqual(api.normalizeSourceCrop({x:.2,y:.1,width:.6,height:.7}),{x:.2,y:.1,width:.6,height:.7});
 assert.throws(()=>api.normalizeSourceCrop({x:-.1,y:0,width:1,height:1}),/CROP/);
 assert.throws(()=>api.normalizeSourceCrop({x:.9,y:0,width:.3,height:1}),/CROP/);
 const img={id:'image-1',kind:'image',src:'/assets/xiaoshimei-character.png',crop:{x:.2,y:.1,width:.6,height:.7},x:10,y:10,width:50,height:40};
 const saved=api.normalizeFreeObjects([img])[0];assert.deepEqual(saved.crop,img.crop);assert.equal(saved.src,img.src);
 const changed=api.cropFrameGeometry(saved,img.crop,600,800);assert.ok(changed.width<=saved.width&&changed.height<=saved.height);assert.equal(changed.src,img.src);
});

test('object clipboard freezes bindings and pastes text or cropped image independently across pages',async()=>{
 const api=await import('../src/html-layout.mjs');assert.equal(typeof api.copyFreeObject,'function');
 const c=createBlankContent(),p=c.pages[0];p.title='Original title';p.html_state=api.normalizeHtmlState({...p.html_state,free_objects:[{id:'title-block',kind:'text',binding:'title',x:10,y:10,width:50,height:10,font_size:74,color:'#443322'},{id:'hero-image',kind:'image',binding:'hero',image_id:'hero',x:5,y:25,width:90,height:60,crop:{x:.1,y:.1,width:.8,height:.8}}]},p);
 p.image_style={...p.image_style,src:'xiaoshimei-media://sha256/'+'a'.repeat(64)};p.html_state.image_edits={hero:{zoom:1.2,focalX:40,focalY:60}};
 const before=structuredClone(p),text=api.copyFreeObject(p,p.html_state,'title-block'),image=api.copyFreeObject(p,p.html_state,'hero-image');p.title='Later title';
 const dest={...structuredClone(p),title:'Another page',html_state:{...p.html_state,free_objects:[]}};
 const pasted=api.pasteFreeObject(dest.html_state,text,'new-text',0);assert.equal(pasted.free_objects[0].text,'Original title');assert.equal(pasted.free_objects[0].binding,undefined);assert.equal(pasted.free_objects[0].font_size,74);
 const twice=api.pasteFreeObject(pasted,image,'new-image',0);assert.equal(twice.free_objects[1].src,p.image_style.src);assert.equal(twice.free_objects[1].image_id,'new-image');assert.deepEqual(twice.free_objects[1].crop,before.html_state.free_objects[1].crop);assert.equal(twice.image_edits['new-image'].zoom,1.2);assert.deepEqual(p.html_state,before.html_state);
 assert.throws(()=>api.pasteFreeObject(twice,{schema:'bad'},'new',0),/CLIPBOARD/);
});

test('short paired scenes get equal image stages with same top and left-aligned copy beneath',async()=>{
 const {composeEditableContent}=await import('../src/visual-workbench/model.mjs');const c=createBlankContent();const p=c.pages[0];p.title='两点提醒';p.page_role='method';p.body='';p.info_panels=[0,1].map(i=>({id:'p'+i,title:'注意事项'+i,body:'检查状态，发现异常就停止。',image_style:{src:'/assets/xiaoshimei-character-full.png',hidden:false}}));
 const out=composeEditableContent(c,{force:true}),objects=out.pages[0].html_state.free_objects,images=objects.filter(o=>o.kind==='image');assert.equal(images.length,2);assert.equal(images[0].height,images[1].height);assert.equal(images[0].width,images[1].width);assert.equal(images[0].y,images[1].y);
 const titles=objects.filter(o=>/^panel-\d+-title$/.test(o.binding||''));assert.ok(titles.every(o=>o.y>images[0].y+images[0].height));assert.ok(titles.every(o=>o.align==='left'));
});


test('copy and crop retain old rotated records without exposing new rotation commands',async()=>{
 const api=await import('../src/html-layout.mjs');const page=createBlankContent().pages[0];page.image_style={...page.image_style,src:'/assets/xiaoshimei-character.png'};page.html_state={free_objects:api.normalizeFreeObjects([{id:'old-image',kind:'image',binding:'hero',image_id:'hero',rotation:17,x:10,y:10,width:45,height:30,crop:{x:.1,y:.1,width:.8,height:.8}}]),image_edits:{hero:{zoom:1.2,focalX:38,focalY:56}}};
 const duplicate=api.duplicateFreeObject(page,page.html_state,'old-image','independent-image');assert.equal(duplicate.free_objects[1].rotation,17);assert.deepEqual(duplicate.free_objects[1].crop,page.html_state.free_objects[0].crop);assert.deepEqual(duplicate.image_edits['independent-image'],page.html_state.image_edits.hero);assert.equal(page.html_state.free_objects.length,1);
 const full={...page.html_state,free_objects:Array.from({length:128},(_,i)=>({...page.html_state.free_objects[0],id:'object-'+i}))};const before=structuredClone(full);assert.throws(()=>api.pasteFreeObject(full,api.copyFreeObject(page,page.html_state,'old-image'),'extra'),/FREE_OBJECTS_INVALID/);assert.deepEqual(full,before);
});

test('editorial three-step pages keep source panel order and readable type without unnecessary expansion',async()=>{
 const {composeEditableContent,mobileReadability}=await import('../src/visual-workbench/model.mjs');const c=createBlankContent();const p=c.pages[0];p.title='日常的三个小步骤';p.eyebrow='生活练习';p.page_role='method';p.body='';p.info_panels=[0,1,2].map(i=>({id:'p'+i,title:'步骤'+i,body:'保留每一步具体的说明，不减少原文。',image_style:{src:'/assets/xiaoshimei-character-full.png'}}));
 const {seedEditableObjects}=await import('../src/visual-workbench/model.mjs');p.html_state={free_objects:seedEditableObjects(p).reverse()};const before=structuredClone(c);const out=composeEditableContent(c,{force:true,editorial:true});assert.equal(out.pages.length,1);assert.deepEqual(c,before);assert.equal(mobileReadability(out.pages[0]).readable,true);
 const a=out.pages[0].html_state.free_objects;const y=i=>a.find(o=>o.binding==='panel-'+i).y;assert.ok(y(0)<y(1)&&y(1)<y(2));
});


test('source crop confirmation resets old image zoom in the same undoable state without altering other images',async()=>{
 const api=await import('../src/html-layout.mjs');assert.equal(typeof api.applySourceCrop,'function');
 const state={free_objects:api.normalizeFreeObjects([{id:'img',kind:'image',binding:'hero',image_id:'hero',x:5,y:5,width:40,height:50},{id:'other',kind:'image',src:'/assets/xiaoshimei-character.png',image_id:'other',x:50,y:5,width:40,height:50}]),image_edits:{hero:{zoom:1.6,focalX:25,focalY:70},other:{zoom:1.2,focalX:45,focalY:50}}};
 const before=structuredClone(state),item=api.cropFrameGeometry(state.free_objects[0],{x:.1,y:.2,width:.8,height:.5},600,800),after=api.applySourceCrop(state,item);
 assert.deepEqual(after.image_edits.hero,{zoom:1,focalX:50,focalY:50});assert.deepEqual(after.image_edits.other,before.image_edits.other);assert.deepEqual(state,before);assert.deepEqual(after.free_objects[0].crop,item.crop);
});


function freshNarrativeCopyFixture(){
 const c=createBlankContent();const seed=structuredClone(c.pages[0]);
 c.body='回家后，先把包放在门边。\n把桌上的杯子和物品归位，接着打开小灯。\n慢慢喝一杯温水。\n记下一件想留下的小事。把明天要带的东西放在门边。\n没有做完也没关系。感到烦躁就停下，不要硬撑。';
 c.generation={mode:'PROVIDER',provider:'volcengine-ark',production_mode:'narrative',run_id:'paid-original-run'};
 const topics=[['轻轻开始','门边放好通勤包','通勤包'],['桌面和灯光','整理桌上杯子和物品，打开柔和小灯','桌面杯子小灯'],['坐下喝水','慢慢坐下，喝一杯温水','喝一杯温水'],['记录和准备','记下一件小事，把明天东西放在门边','笔记本明天东西门边'],['不必全部做完','没做完也没关系，感到烦躁就停下，不要硬撑','休息停下']];
 c.pages=topics.map(([title,body,action],i)=>({...structuredClone(seed),page_role:i?'method':'hook',title,body,visual_action:action,image_prompt:action,visual:'character',image_style:{...seed.image_style,src:'/assets/real-'+i+'.png',hidden:false},info_panels:[],html_state:undefined}));c.visible_pages=5;return c;
}

test('new narrative materialization uses original ordered copy once instead of front-loading duplicate supplements',async()=>{
 const {materializeGeneratedCopy,confirmedCopyCoverage}=await import('../src/visual-workbench/model.mjs');const c=freshNarrativeCopyFixture(),before=structuredClone(c);const out=materializeGeneratedCopy(c);
 assert.deepEqual(c,before);assert.equal(out.pages.length,5);assert.equal(out.pages[0].body,'');assert.equal(out.pages[0].html_state.free_objects.some(o=>o.binding==='body'),false);
 assert.equal(out.pages.map(p=>p.body).join(''),c.body);assert.deepEqual(confirmedCopyCoverage(out).missing,[]);assert.equal(out.pages.some(p=>p.eyebrow==='原文补充'),false);
 out.pages.forEach((p,i)=>{assert.equal(p.image_style.src,c.pages[i].image_style.src);assert.equal(p.visual_action,c.pages[i].visual_action);assert.equal(p.title,c.pages[i].title);assert.ok(p.html_state.free_objects.some(o=>o.kind==='image'));});
 assert.ok(out.pages[1].body.includes('打开小灯'));assert.ok(out.pages[2].body.includes('温水'));assert.ok(out.pages[3].body.includes('明天'));assert.ok(out.pages[4].body.includes('不要硬撑'));assert.deepEqual(out.generation,c.generation);assert.equal(out.body,c.body);
 assert.deepEqual(materializeGeneratedCopy(out),out,'existing editable work is not repacked');
});

test('new-source alignment never hides missing repeated steps, numbers, or negations',async()=>{
 const {materializeGeneratedCopy}=await import('../src/visual-workbench/model.mjs');const c=freshNarrativeCopyFixture();c.body='先把杯子放好，不要打开手机。\n慢慢喝水30毫升。不要喝水300毫升。\n记下今天一件小事。再记下今天一件小事。\n最后停下来，不要硬撑。';c.pages[1].body='杯子和手机的位置';c.pages[2].body='喝水30毫升，不要喝水300毫升';c.pages[3].body='记录今天一件小事';
 const out=materializeGeneratedCopy(c);assert.equal(out.pages.map(p=>p.body).join(''),c.body);assert.equal((out.pages.map(p=>p.body).join('').match(/今天一件小事/g)||[]).length,2);assert.equal(out.body,c.body);
});

test('unmatched or oversized source fails atomically instead of guessing topic/image alignment',async()=>{
 const {materializeGeneratedCopy}=await import('../src/visual-workbench/model.mjs');const c=freshNarrativeCopyFixture();c.body='量子态保持叠加。电子穿过势垒。恒星坍缩形成黑洞。探测器收到引力波。宇宙持续膨胀。';const before=structuredClone(c);
 assert.throws(()=>materializeGeneratedCopy(c),e=>e.code==='GENERATED_COPY_ALIGNMENT_UNCONFIRMED');assert.deepEqual(c,before);
 const big=freshNarrativeCopyFixture();big.body='超长原文。'.repeat(600);const exact=structuredClone(big);assert.throws(()=>materializeGeneratedCopy(big),e=>e.code==='GENERATED_COPY_ALIGNMENT_LIMIT');assert.deepEqual(big,exact);
 const edited=freshNarrativeCopyFixture();edited.pages[1].html_state={free_objects:[{id:'user-note',kind:'text',text:'人工编辑',x:4,y:5,width:80,height:10,font_size:54}]};assert.throws(()=>materializeGeneratedCopy(edited),e=>e.code==='GENERATED_COPY_ALREADY_EDITABLE');
});


test('literal confirmed opening can stay on the cover exactly once; later methods keep their order',async()=>{
 const {materializeGeneratedCopy}=await import('../src/visual-workbench/model.mjs');const c=freshNarrativeCopyFixture();const first=c.body.slice(0,c.body.indexOf('\n')+1);c.pages[0].body=first.replace(/\s/gu,'');
 const out=materializeGeneratedCopy(c);assert.equal(out.pages[0].body,first);assert.equal(out.pages.map(p=>p.body).join(''),c.body);assert.equal(out.pages.slice(1).some(p=>p.body.includes(first.trim())),false);
});


test('initial generation callback consumes fresh narrative alignment without reinterpreting existing editor state',async()=>{
 const {materializeGeneratedCopy}=await import('../src/visual-workbench/model.mjs');const c=freshNarrativeCopyFixture();assert.equal(materializeGeneratedCopy(c).pages.map(p=>p.body).join(''),c.body);
 const {readFile}=await import('node:fs/promises');const main=await readFile(new URL('../src/visual-workbench/main.jsx',import.meta.url),'utf8');assert.match(main,/prepareContent:value=>session.image_variant_target\?composeEditableContent\(value,\{measureText:measureEditableText\}\):materializeGeneratedCopy\(value,\{measureText:measureEditableText\}\)/);
});

test('non-narrative generated content retains the previous reconciliation path, not a new no-op contract',async()=>{
 const {materializeGeneratedCopy,reconcileConfirmedCopy}=await import('../src/visual-workbench/model.mjs');const c=freshNarrativeCopyFixture();c.generation.production_mode='smart';const expected=reconcileConfirmedCopy(c);assert.deepEqual(materializeGeneratedCopy(c),expected);assert.equal(expected.body,c.body);
});
