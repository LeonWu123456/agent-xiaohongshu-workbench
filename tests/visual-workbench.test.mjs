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

test('direct resize controls use the same 72 percent floor as the persistent object model',async()=>{
 const [main,editor]=await Promise.all([readFile(new URL('../src/visual-workbench/main.jsx',import.meta.url),'utf8'),readFile(new URL('../src/HtmlPageEditor.jsx',import.meta.url),'utf8')]);
 assert.match(main,/aria-label="模块大小" type="range" min="\.72" max="1\.4"/);
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
