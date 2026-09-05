import {generateContentPackage, parseContentPackage, importLocalEditableDraft, reorderPage, duplicatePage, deletePage} from '../content-engine.mjs';
import {normalizeHtmlState} from '../html-layout.mjs';
export function changePage(content, index, patch) {
  if (!content?.pages?.[index]) throw new TypeError('页面不存在');
  const next={...content,pages:content.pages.map((p,i)=>i===index?{...p,...patch}:p)};
  if(index===0 && patch.title?.trim()) {
    next.titles=content.titles.map(t=>t===content.selectedTitle?patch.title:t);
    next.selectedTitle=patch.title;
  }
  return next;
}
export function replacePageImage(page, imageId, src) {
  if(!/^(data:image\/(png|jpeg|webp);base64,|blob:|\/assets\/|xiaoshimei-media:\/\/sha256\/|https:\/\/)/i.test(src)) throw new TypeError('不支持这张图片的来源');
  if(imageId==='hero')return {...page,visual:'character',image_style:{...page.image_style,src}};
  const index=Number(String(imageId).replace(/^panel-/,''));
  if(!Number.isInteger(index)||!page.info_panels?.[index])throw new TypeError('图片对象不存在');
  return {...page,info_panels:page.info_panels.map((p,i)=>i===index?{...p,image_style:{...p.image_style,src,hidden:false}}:p)};
}
export function listPageObjects(page,index) {
  const items=[{id:'title-block',label:'标题',kind:'text'}];
  if(normalizeHtmlState(page.html_state,page,index).layout_id==='cover-poster')items.push({id:'cover-lede',label:'引言',kind:'text'});
  if(page.info_panels?.length) page.info_panels.forEach((p,i)=>{
    items.push({id:`panel-${i}-copy`,label:p.title||`段落 ${i+1}`,kind:'text'});
    if(p.image_style?.src&&!p.image_style.hidden)items.push({id:`panel-${i}-image`,imageId:`panel-${i}`,label:`插图 ${i+1}`,kind:'image'});
  }); else {
    if(normalizeHtmlState(page.html_state,page,index).layout_id!=='cover-poster')items.push({id:'body-block',label:'正文',kind:'text'});
    if(page.visual!=='none'&&page.image_style?.src)items.push({id:'hero-image',imageId:'hero',label:'主图片',kind:'image'});
  }
  return items;
}

export function addContentPage(content, index = content.visible_pages - 1) {
  if (!Number.isInteger(index) || index < 0 || index >= content.visible_pages) throw new RangeError('page index is invalid');
  const next = duplicatePage(content, index);
  const target = index + 1;
  const source = next.pages[target];
  const blank = {
    ...source,
    eyebrow: '新页面',
    title: '点击输入标题',
    body: '点击这里编辑内容。',
    highlight_phrases: [],
    info_panels: [],
    image_style: { ...(source.image_style || {}) },
    visual: 'none',
    page_role: 'example',
    editor_mode: 'html',
    html_state: undefined,
  };
  return { ...next, pages: next.pages.map((page, pageIndex) => pageIndex === target ? blank : page) };
}
export const duplicateContentPage = (content, index) => duplicatePage(content, index);
export const deleteContentPage = (content, index) => deletePage(content, index);
export const reorderContentPage = (content, from, to) => reorderPage(content, from, to);
export function clampPageIndex(content, index) { const count=Math.max(1,Number(content?.visible_pages||content?.pages?.length||1)); return Math.max(0,Math.min(Number.isInteger(index)?index:0,count-1)); }

export function createBlankContent() {
  const base = generateContentPackage({ topic: '未命名作品', pillar: 'wellness', goal: 'save' });
  const page = {
    ...base.pages[0],
    eyebrow: '新作品',
    title: '未命名作品',
    body: '点击这里开始编辑。',
    highlight_phrases: [],
    info_panels: [],
    image_style: { ...(base.pages[0].image_style || {}) },
    visual: 'none',
    page_role: 'hook',
    editor_mode: 'html',
    html_state: undefined,
  };
  return parseContentPackage(JSON.stringify({ ...base, body:'', tags:['','','','',''], pages:[page], visible_pages:1, selectedTitle:'未命名作品', titles:['未命名作品','新的表达','我的新作品'], stage:'LOCAL_DRAFT', scale_permission:'UNVERIFIED' }));
}

export function importEditableContent(raw) {
  const parsed=parseContentPackage(typeof raw==='string'?raw:JSON.stringify(raw));
  if(parsed.pages.some(p=>p.editor_mode==='fabric'||(p.editor_state&&!p.html_state)))throw new TypeError('这份旧稿含自由画布数据；请先从旧编辑器导出兼容图文，不会覆盖原稿。');
  return importLocalEditableDraft(JSON.stringify({...parsed,stage:'LOCAL_DRAFT',visible_pages:parsed.pages.length,scale_permission:'UNVERIFIED'}));
}
export function createDemo() {
  const source=generateContentPackage({topic:'把日子过成喜欢的样子',pillar:'wellness',goal:'save'});
  const copy=[['给生活，留一点空白','少一点匆忙，多一点自己。\n把注意力还给眼前的小事。'],['从一件小事开始','放下手机，望一会儿远处。\n给自己倒一杯温水。\n今天，不必把每分钟填满。'],['按自己的节奏生活','慢一点，没有关系。\n记录一个让你感到轻松的瞬间。']];
  source.pages=source.pages.slice(0,3).map((p,i)=>({...p,eyebrow:['生活练习 01','日常灵感 02','写给自己 03'][i],title:copy[i][0],body:copy[i][1],page_role:i===0?'hook':'closing',editor_mode:'html',image_style:{...p.image_style,src:'/assets/xiaoshimei-character-full.png'},html_state:undefined}));
  source.selectedTitle=copy[0][0];source.titles=[copy[0][0],'让生活留白','找到自己的节奏'];
  source.stage='LOCAL_DRAFT';source.visible_pages=3;source.scale_permission='UNVERIFIED';
  return parseContentPackage(JSON.stringify(source));
}
