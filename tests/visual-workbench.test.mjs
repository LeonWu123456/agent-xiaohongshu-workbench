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
