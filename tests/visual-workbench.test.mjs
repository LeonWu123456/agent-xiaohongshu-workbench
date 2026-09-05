import test from 'node:test';
import assert from 'node:assert/strict';
import { generateContentPackage } from '../src/content-engine.mjs';
import { changePage, replacePageImage, listPageObjects, importEditableContent } from '../src/visual-workbench/model.mjs';
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
