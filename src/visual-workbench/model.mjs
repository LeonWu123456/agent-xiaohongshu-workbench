import {applySmartLayoutSequence} from '../smart-layout.mjs';
import {generateContentPackage, parseContentPackage, importLocalEditableDraft, reorderPage, duplicatePage, deletePage} from '../content-engine.mjs';
import {normalizeHtmlState,freeObjectText,normalizeFreeObjects} from '../html-layout.mjs';
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
  if(imageId==='hero')return {...page,visual:'character',image_style:{...page.image_style,src,hidden:false}};
  const index=Number(String(imageId).replace(/^panel-/,''));
  if(!Number.isInteger(index)||!page.info_panels?.[index])throw new TypeError('图片对象不存在');
  return {...page,info_panels:page.info_panels.map((p,i)=>i===index?{...p,image_style:{...p.image_style,src,hidden:false}}:p)};
}
export function listPageObjects(page,index) {
  if(page.html_state?.free_objects)return page.html_state.free_objects.map(o=>({id:o.id,kind:o.kind,imageId:o.kind==='image'?o.image_id:null,label:o.kind==='image'?'\u56fe\u7247':freeObjectText(page,o).slice(0,16)||'\u7a7a\u6587\u5b57'}));
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


function estimateTextHeight({text,width,fontSize,lineHeight}) {
 return String(text).split('\n').reduce((height,line)=>{
  const units=[...line].reduce((n,c)=>n+(/[^\x00-\x7f]/.test(c)?1:.56),0);
  return height+Math.max(1,Math.ceil(units*fontSize/width))*fontSize*lineHeight;
 },0);
}
export function seedEditableObjects(page,pageIndex=0) {
 const objects=[];
 const text=(id,binding,size,weight=400)=>{if(freeObjectText(page,{binding}).trim())objects.push({id,kind:'text',binding,x:7,y:7,width:86,height:10,font_size:size,font_family:binding==='title'?'songti':'pingfang',font_weight:weight,line_height:binding==='title'?1.15:1.5,color:binding==='eyebrow'?page.accent:'#292720'});};
 const image=(id,binding)=>objects.push({id,kind:'image',image_id:binding,binding,fit:'contain',x:7,y:30,width:86,height:50});
 text('eyebrow-text','eyebrow',28);text('title-block','title',pageIndex===0?92:64,700);
 if(page.info_panels?.length){page.info_panels.forEach((panel,i)=>{text(`panel-${i}-title`,`panel-${i}-title`,40,700);text(`panel-${i}-copy`,`panel-${i}-body`,34);if(panel.image_style?.src&&!panel.image_style.hidden)image(`panel-${i}-image`,`panel-${i}`);});}
 else{text('body-block','body',36);if(page.visual!=='none'&&page.image_style?.src&&!page.image_style.hidden)image('hero-image','hero');}
 return normalizeFreeObjects(objects);
}

export function arrangeEditablePage(page,pageIndex=0,{measureText=estimateTextHeight}={}) {
 const source=normalizeFreeObjects(page.html_state?.free_objects||seedEditableObjects(page,pageIndex));
 const header=source.filter(o=>o.kind==='text'&&['eyebrow','title'].includes(o.binding)).sort((a,b)=>(a.binding==='eyebrow'?-1:1));
 const rest=source.filter(o=>!header.includes(o)),groups=new Map();
 for(const o of rest){const panel=/^panel-(\d+)/.exec(o.binding||'');const key=panel?'panel-'+panel[1]:(o.binding==='body'||o.binding==='hero')?'main':o.id;const group=groups.get(key)||{texts:[],images:[]};group[o.kind==='text'?'texts':'images'].push(o);groups.set(key,group);}
 const ordered=[...groups.values()];const margin=72,contentWidth=936,bottom=1368;
 for(const factor of [1,.92,.84,.76]){
  const updates=new Map();let y=72;
  const put=(o,x,top,width,height,extra={})=>updates.set(o.id,{...o,x:x/10.8,y:top/14.4,width:width/10.8,height:Math.max(8,height)/14.4,rotation:0,...extra});
  const measure=(o,width)=>{const fontSize=Math.max(o.binding==='title'?48:26,o.font_size*factor);const height=Math.ceil(measureText({text:freeObjectText(page,o),width,fontSize,fontFamily:o.font_family,fontWeight:o.font_weight,lineHeight:o.line_height,paragraphGap:o.paragraph_gap}))+3;return{height,fontSize};};
  for(const o of header){const m=measure(o,contentWidth);put(o,margin,y,contentWidth,m.height,{font_size:m.fontSize});y+=m.height+(o.binding==='eyebrow'?18:36);}
  for(let i=0;i<ordered.length;i++){
   const group=ordered[i],cover=pageIndex===0&&ordered.length===1&&group.images.length===1;
   const textWidth=group.images.length&&!cover&&group.texts.length?580:contentWidth;
   const sizes=group.texts.map(o=>measure(o,textWidth));const textHeight=sizes.reduce((h,m,j)=>h+m.height+(j?16:0),0);
   if(cover){let top=y;group.texts.forEach((o,j)=>{put(o,margin,top,textWidth,sizes[j].height,{font_size:sizes[j].fontSize});top+=sizes[j].height+16;});const height=Math.max(300,bottom-top-24);put(group.images[0],margin,top+12,contentWidth,height);y=top+12+height;}
   else if(group.images.length&&group.texts.length){const rowHeight=Math.max(190*factor*group.images.length,textHeight);const imageLeft=(pageIndex+i)%2===0;let top=y;group.texts.forEach((o,j)=>{put(o,imageLeft?428:margin,top,textWidth,sizes[j].height,{font_size:sizes[j].fontSize});top+=sizes[j].height+16;});const imageHeight=(rowHeight-16*(group.images.length-1))/group.images.length;group.images.forEach((o,j)=>put(o,imageLeft?margin:688,y+j*(imageHeight+16),320,imageHeight));y+=rowHeight;}
   else if(group.texts.length){let top=y;group.texts.forEach((o,j)=>{put(o,margin,top,contentWidth,sizes[j].height,{font_size:sizes[j].fontSize});top+=sizes[j].height+16;});y=top;}
   else{const columns=Math.min(2,group.images.length),width=(contentWidth-24*(columns-1))/columns;group.images.forEach((o,j)=>put(o,margin+(j%columns)*(width+24),y+Math.floor(j/columns)*340,width,316));y+=Math.ceil(group.images.length/columns)*340;}
   if(i<ordered.length-1)y+=32;
  }
  if(y<=bottom+1){return{...page,editor_mode:'html',html_state:{...normalizeHtmlState(page.html_state,page,pageIndex),free_objects:normalizeFreeObjects(source.map(o=>updates.get(o.id)||o))}};}
 }
 const error=new Error(`\u7b2c${pageIndex+1}\u9875\u5185\u5bb9\u8fc7\u591a\uff0c\u8bf7\u62c6\u5206\u9875\u9762\u540e\u518d\u6392\u7248\uff1b\u539f\u6587\u548c\u56fe\u7247\u5747\u4fdd\u7559\u3002`);error.code='EDITABLE_LAYOUT_NEEDS_SPLIT';error.page=pageIndex;throw error;
}

export function composeEditableContent(content,{force=false,pageIndex=null,measureText}={}) {
 if(!content?.pages?.length)throw new TypeError('EDITABLE_CONTENT_MISSING');
 const pages=applySmartLayoutSequence(content.pages).map((page,i)=>{
  if(pageIndex!==null&&pageIndex!==i)return content.pages[i];
  if(!force&&page.html_state?.free_objects)return content.pages[i];
  return arrangeEditablePage(page,i,{measureText});
 });
 return {...content,pages};
}
