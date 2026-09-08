import {applySmartLayoutSequence} from '../smart-layout.mjs';
import {generateContentPackage, parseContentPackage, importLocalEditableDraft, reorderPage, duplicatePage, deletePage,invalidateVisualReview} from '../content-engine.mjs';
import {normalizeHtmlState,freeObjectText,freeObjectImage,normalizeFreeObjects} from '../html-layout.mjs';
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
 text('eyebrow-text','eyebrow',42);text('title-block','title',pageIndex===0?114:102,700);
 if(page.info_panels?.length){page.info_panels.forEach((panel,i)=>{text(`panel-${i}-title`,`panel-${i}-title`,72,700);text(`panel-${i}-copy`,`panel-${i}-body`,54);if(panel.image_style?.src&&!panel.image_style.hidden)image(`panel-${i}-image`,`panel-${i}`);});}
 else{text('body-block','body',54);if(page.visual!=='none'&&page.image_style?.src&&!page.image_style.hidden)image('hero-image','hero');}
 return normalizeFreeObjects(objects);
}


export const MOBILE_READING = Object.freeze({pageWidth:1080,viewportWidth:360,body:54,label:42,title:102,section:72});
function mobileType(item,pageIndex){
 if(item.kind!=='text')return item;
 const binding=item.binding||'',isTitle=binding==='title',isLabel=binding==='eyebrow',isSection=/^panel-\d+-title$/.test(binding);
 const floor=isLabel?42:isTitle?(pageIndex===0?114:102):isSection?72:54;
 return {...item,font_size:Math.max(floor,item.font_size),line_height:isTitle?1.12:isLabel?1.3:isSection?1.2:Math.max(1.5,item.line_height),color:isLabel&&item.color.toLowerCase()==='#e6773d'?'#9b4f32':item.color};
}
function layoutOverflow(pageIndex,code='EDITABLE_LAYOUT_NEEDS_SPLIT'){
 const e=new Error(`\u7b2c${pageIndex+1}\u9875\u5185\u5bb9\u8fc7\u591a\uff0c\u8bf7\u62c6\u9875\u540e\u518d\u6392\u7248\uff1b\u4e0d\u4f1a\u7f29\u5c0f\u6b63\u6587\u6216\u5220\u9664\u56fe\u6587\u3002`);e.code=code;e.page=pageIndex;return e;
}
// Pagination reuses the existing page/undo contract. Only complete, canonical
// multi-panel groups can be split automatically; custom/deleted objects stay put.
function mobilePages(content,{force,pageIndex,measureText,editorial}){
 const out=[],touched=new Set(),splitStarts=new Map();let changed=false;
 content.pages.forEach((page,i)=>{
  if(i>=content.visible_pages||(pageIndex!==null&&pageIndex!==i)||(!force&&page.html_state?.free_objects)){out.push(page);return;}
  const panels=page.info_panels||[],objects=page.html_state?.free_objects;
  const canonical=new Set(['eyebrow','title',...panels.flatMap((_,j)=>[`panel-${j}-title`,`panel-${j}-body`,`panel-${j}`])]);
  const intact=!objects||(objects.some(o=>o.binding==='title')&&(!page.eyebrow?.trim()||objects.some(o=>o.binding==='eyebrow'))&&objects.every(o=>canonical.has(o.binding))&&panels.every((p,j)=>objects.some(o=>o.binding===`panel-${j}-body`)&&objects.some(o=>o.binding===`panel-${j}-title`)&&(!p.image_style?.src||p.image_style.hidden||objects.some(o=>o.binding===`panel-${j}`))));
  if(panels.length<3||!intact){touched.add(out.length);out.push(page);return;}
  // Split only when the current page actually cannot fit at readable type.
  try{arrangeEditablePage(page,i,{measureText,editorial});touched.add(out.length);out.push(page);return;}
  catch(error){if(error.code!=='EDITABLE_LAYOUT_NEEDS_SPLIT')throw error;}
  changed=true;splitStarts.set(i,out.length);
  panels.forEach((panel,j)=>{

   // The canonical panel contract requires 2-4 panels. A one-scene reading
   // page is therefore a normal body+hero page, not an invalid one-panel list.
   const sub={...page,eyebrow:[page.eyebrow,page.title].filter(Boolean).join(' / '),title:panel.title,body:panel.body,visual_action:panel.visual_action||'',image_prompt:panel.image_prompt||'',info_panels:[],image_style:{...panel.image_style},visual:panel.image_style?.src&&!panel.image_style.hidden?'character':'none',layout_ir:null,layout_recipe:null,editor_mode:'html',html_state:undefined};
   const state=normalizeHtmlState(null,sub,out.length),source=seedEditableObjects(sub,out.length);
   const previousBinding={title:`panel-${j}-title`,body:`panel-${j}-body`,hero:`panel-${j}`};
   const next=source.map(o=>{
    const old=objects?.find(x=>x.binding===previousBinding[o.binding]);
    if(old)return{...old,id:o.id,binding:o.binding,...(o.kind==='image'?{image_id:o.image_id}:{})};return o;
   });
   // Page-level copy that the old multi-panel renderer hid is not discarded.

   const originalCrop=page.html_state?.image_edits?.[`panel-${j}`];sub.html_state={...state,free_objects:normalizeFreeObjects(next),...(originalCrop?{image_edits:{...state.image_edits,hero:{...originalCrop}}}:{})};
   touched.add(out.length);out.push(sub);
  });
  // Preserve the old last-child placement when it fits. Otherwise only the
  // parent's exact ordered sentence spans flow across this same sibling group.
  if(page.body?.trim()&&page.body!==panels.at(-1).body){
   const start=splitStarts.get(i),children=out.slice(start),context=text=>({id:'context-copy',kind:'text',text,x:5,y:70,width:90,height:10,font_size:54,font_family:'pingfang',font_weight:400,line_height:1.5,color:'#292720'});
   const append=(child,text)=>({...child,html_state:{...child.html_state,free_objects:normalizeFreeObjects([...child.html_state.free_objects,context(text)])}});
   const last=append(children.at(-1),page.body);
   try{arrangeEditablePage(last,start+children.length-1,{measureText});out[out.length-1]=last;}
   catch(error){
    if(error.code!=='EDITABLE_LAYOUT_NEEDS_SPLIT')throw error;
    const spans=String(page.body).match(/[^。！？\r\n]*(?:[。！？]|\r\n|\r|\n|$)/gu).filter(Boolean);
    if(spans.join('')!==page.body)throw error;
    let cursor=0;
    for(let c=0;c<children.length&&cursor<spans.length;c++){
     let accepted=null,next=cursor;
     for(let n=cursor+1;n<=spans.length;n++){
      const candidate=append(children[c],spans.slice(cursor,n).join(''));
      try{arrangeEditablePage(candidate,start+c,{measureText});accepted=candidate;next=n;}
      catch(e){if(e.code!=='EDITABLE_LAYOUT_NEEDS_SPLIT')throw e;break;}
     }
     if(accepted){out[start+c]=accepted;cursor=next;}
    }
    if(cursor!==spans.length)throw error;
   }
  }
 });

 // A reading cover gets one opening sentence, not a reduced-size paragraph.
 // Its remaining exact text flows into the first automatically split scene.
 // This only runs in explicit whole-work reflow/new composition, never on load
 // or on a manually edited/deleted object set. A second reflow is idempotent.
 const cover=out[0],coverObjects=cover?.html_state?.free_objects;
 if(!content.pages[0]?.info_panels?.length&&pageIndex===null&&splitStarts.has(1)&&content.visible_pages>1&&(force||!coverObjects)&&!cover.info_panels?.length&&cover.image_style?.src&&cover.body?.length>60&&(!coverObjects||(coverObjects.some(o=>o.binding==='body')&&coverObjects.every(o=>['title','eyebrow','body','hero'].includes(o.binding))))){
  const parts=/^([\s\S]*?[。！？!?])([\s\S]+)$/.exec(cover.body);
  if(parts&&parts[2].trim()){
   out[0]={...cover,body:parts[1]};const target=splitStarts.get(1),next=out[target];
   const prefix={id:'opening-continuation',kind:'text',text:parts[2],x:5,y:60,width:90,height:10,font_size:54,font_family:'pingfang',font_weight:400,line_height:1.5,color:'#292720'};
   const objects=[...next.html_state.free_objects],at=objects.findIndex(o=>o.binding==='body');objects.splice(Math.max(0,at),0,prefix);
   out[target]={...next,html_state:{...next.html_state,free_objects:normalizeFreeObjects(objects)}};touched.add(0);
  }
 }
 if(out.length>8)throw layoutOverflow(0,'MOBILE_PAGE_LIMIT');
 return{pages:out,changed,touched};
}
export function arrangeEditablePage(page,pageIndex=0,{measureText=estimateTextHeight,editorial=false}={}){
 const raw=normalizeFreeObjects(page.html_state?.free_objects||seedEditableObjects(page,pageIndex));
 const compactSteps=editorial&&raw.filter(o=>o.kind==='image').length===3&&page.info_panels?.length===3;
 const source=raw.map(o=>{const next=mobileType(o,pageIndex);if(!compactSteps)return next;
  return next.kind!=='text'?next:{...next,font_size:next.binding==='title'?84:next.binding==='eyebrow'?36:/^panel-\d+-title$/.test(next.binding||'')?60:next.font_size,line_height:next.binding==='title'?1.1:next.binding==='eyebrow'?1.18:/^panel-\d+-title$/.test(next.binding||'')?1.2:1.45};});
 const headers=source.filter(o=>o.kind==='text'&&['eyebrow','title'].includes(o.binding)).sort((a,b)=>Number(b.binding==='eyebrow')-Number(a.binding==='eyebrow'));
 const images=source.filter(o=>o.kind==='image'),copy=source.filter(o=>o.kind==='text'&&!headers.includes(o));
 const left=54,width=972,bottom=1386,updates=new Map();let y=54;
 const put=(o,x,top,w,h)=>updates.set(o.id,{...o,x:x/10.8,y:top/14.4,width:w/10.8,height:Math.max(8,h)/14.4,rotation:0});
 const height=(o,w)=>Math.ceil(measureText({text:freeObjectText(page,o),width:w,fontSize:o.font_size,fontFamily:o.font_family,fontWeight:o.font_weight,lineHeight:o.line_height,paragraphGap:o.paragraph_gap}))+4;
 for(const o of headers){const text=freeObjectText(page,o),n=[...text].length;const balance=o.binding==='title'&&n>8&&n<=20&&/^[\u3400-\u9fff\s，。！？、]+$/.test(text)&&height(o,width)>o.font_size*o.line_height+6;const w=balance?Math.min(width,Math.ceil(n/2)*o.font_size*1.055):width;const h=height(o,w);put(o,left,y,w,h);y+=h+(o.binding==='eyebrow'?22:34);}
 if(images.length===1){
  const heights=copy.map(o=>height(o,width)),copyH=heights.reduce((n,h)=>n+h,0)+Math.max(0,copy.length-1)*22;
  const imageH=bottom-y-copyH-(copy.length?34:0);
  if(imageH<360)throw layoutOverflow(pageIndex);
  // One scene is the visual anchor. Copy spans the phone width below it, never
  // squeezed into a narrow column beside a thumbnail.
  put(images[0],left,y,width,imageH);y+=imageH+(copy.length?34:0);
  copy.forEach((o,j)=>{put(o,left,y,width,heights[j]);y+=heights[j]+(j<copy.length-1?22:0);});
 }else if(images.length===0){
  for(const o of copy){const h=height(o,width);put(o,left,y,width,h);y+=h+24;}
 }else{
  const groups=new Map();
  for(const o of source.filter(o=>!headers.includes(o))){const panel=/^panel-(\d+)/.exec(o.binding||'');const key=panel?'panel-'+panel[1]:o.id;const group=groups.get(key)||{texts:[],images:[]};group[o.kind==='text'?'texts':'images'].push(o);groups.set(key,group);}

  const orderedGroups=[...groups.entries()].sort(([a],[b])=>/^panel-\d+$/.test(a)&&/^panel-\d+$/.test(b)?Number(a.slice(6))-Number(b.slice(6)):0).map(([,value])=>value);
  const paired=orderedGroups;let pairedPlaced=false;
  if(paired.length===2&&paired.every(g=>g.images.length===1&&g.texts.length>0)){
   const gap=36,column=(width-gap)/2;
   const hs=paired.map(g=>g.texts.map(o=>height(o,column))),th=hs.map(h=>h.reduce((a,b)=>a+b,0)+Math.max(0,h.length-1)*18);
   const imageH=bottom-y-Math.max(...th)-32;
   if(imageH>=360){
    paired.forEach((g,i)=>{const x=left+i*(column+gap);put({...g.images[0],fit:'contain'},x,y,column,imageH);let top=y+imageH+32;g.texts.forEach((o,j)=>{put({...o,align:'left'},x,top,column,hs[i][j]);top+=hs[i][j]+18;});});
    pairedPlaced=true;y=bottom;
   }
  }
  if(!pairedPlaced)for(const group of orderedGroups){

   if(group.images.length&&group.texts.length){const iw=compactSteps?276:378,gap=36,tw=width-iw-gap,spacing=compactSteps?12:18,hs=group.texts.map(o=>height(o,tw));const th=hs.reduce((n,h)=>n+h,0)+Math.max(0,hs.length-1)*spacing;const rowH=Math.max((compactSteps?286:360)*group.images.length,th);let top=y+(rowH-th)/2;
    group.images.forEach((o,j)=>put({...o,fit:'contain'},left,y+j*rowH/group.images.length,iw,rowH/group.images.length));group.texts.forEach((o,j)=>{put({...o,align:'left'},left+iw+gap,top,tw,hs[j]);top+=hs[j]+spacing;});y+=rowH+38;
   }else if(group.texts.length){for(const o of group.texts){const h=height(o,width);put(o,left,y,width,h);y+=h+24;}}
   else{for(const o of group.images){put(o,left,y,width,400);y+=424;}}
  }
  if(!pairedPlaced)y-=38;
 }
 const occupiedBottom=Math.max(0,...[...updates.values()].map(o=>(o.y+o.height)*14.4));
 if(occupiedBottom>bottom+1)throw layoutOverflow(pageIndex);
 return{...page,editor_mode:'html',html_state:{...normalizeHtmlState(page.html_state,page,pageIndex),free_objects:normalizeFreeObjects(source.map(o=>updates.get(o.id)||o))}};
}
export function mobileReadability(page){
 const text=(page?.html_state?.free_objects||[]).filter(o=>o.kind==='text'&&o.binding!=='eyebrow'&&o.binding!=='title'&&!/^panel-\d+-title$/.test(o.binding||''));
 const minimum=text.length?Math.min(...text.map(o=>o.font_size/3)):null;
 return{minimum_body_px:minimum,readable:minimum===null||minimum>=18};
}
export function composeEditableContent(content,{force=false,pageIndex=null,measureText,editorial=false}={}){
 if(!content?.pages?.length)throw new TypeError('EDITABLE_CONTENT_MISSING');
 const prepared=mobilePages(content,{force,pageIndex,measureText,editorial});
 const pages=applySmartLayoutSequence(prepared.pages).map((page,i)=>prepared.touched.has(i)?arrangeEditablePage(page,i,{measureText,editorial}):prepared.pages[i]);
 return invalidateVisualReview({...content,pages,...(prepared.changed?{visible_pages:content.visible_pages+pages.length-content.pages.length,stage:'LOCAL_DRAFT'}:{})});
}


// The publication body remaining in storage does not prove it reached the cards.
// This check is deliberately literal (normalizing whitespace only),
// not a claim of semantic equivalence between a model summary and the source.
const copyKey=value=>String(value||'').replace(/\s+/gu,' ').trim();
function visibleCopy(page,index){
 const objects=page.html_state?.free_objects||seedEditableObjects(page,index);
 return objects.filter(o=>o.kind==='text'&&!['title','eyebrow'].includes(o.binding)&&!/^panel-\d+-title$/.test(o.binding||'')&&o.opacity!==0&&o.x<100&&o.y<100&&o.x+o.width>0&&o.y+o.height>0).map(o=>freeObjectText(page,o)).join('\n');
}
export function confirmedCopyCoverage(content){
 const split=value=>[...String(value||'').matchAll(/[^。！？\r\n]+[。！？]?/gu)].map(m=>({text:m[0].trim(),key:copyKey(m[0])})).filter(x=>x.key);
 const visible=(content?.pages||[]).slice(0,content?.visible_pages||0).flatMap((p,i)=>split(visibleCopy(p,i)).map(x=>({...x,page_index:i})));
 const segments=split(content?.body).map((x,index)=>({...x,index,page_indexes:[]}));
 const n=segments.length,m=visible.length;
 // Bounded sequence matching: each source occurrence must consume one distinct
 // visible occurrence in order. Oversized documents stay explicitly unverified.
 if(n>2048||m>4096||(n+1)*(m+1)>2000000)return{checked_segments:n,segments,missing:segments,unsupported:true};
 const dp=Array.from({length:n+1},()=>new Uint16Array(m+1));
 for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)dp[i][j]=segments[i].key===visible[j].key?1+dp[i+1][j+1]:Math.max(dp[i+1][j],dp[i][j+1]);
 let i=0,j=0;
 while(i<n&&j<m){
  if(segments[i].key===visible[j].key){segments[i].page_indexes=[visible[j].page_index];i++;j++;}
  else if(dp[i][j+1]>=dp[i+1][j])j++;else i++;
 }
 return{checked_segments:n,segments,missing:segments.filter(x=>!x.page_indexes.length),unsupported:false};
}
export function reconcileConfirmedCopy(content,{measureText}={}){
 const repairPages=new Set();
 let result=composeEditableContent(content,{measureText});
 // Only pages materialized in this invocation may be repacked to fit trailing
 // missing copy. Previously edited pages retain the append-a-page contract.
 const freshPages=new Set(result.pages.filter(p=>!content.pages.includes(p)&&!p.info_panels?.length));
 const first=confirmedCopyCoverage(result);if(first.unsupported){const error=new Error('全文或画布句子过多，请先拆分作品；原稿未改变。');error.code='CONFIRMED_COPY_AUDIT_LIMIT';throw error;}if(!first.missing.length)return result;
 for(const missing of first.missing){
  const audit=confirmedCopyCoverage(result),gap=audit.segments[missing.index];
  if(!gap||gap.page_indexes.length)continue;
  const previous=audit.segments.slice(0,gap.index).reverse().find(s=>s.page_indexes.length);
  const following=audit.segments.slice(gap.index+1).find(s=>s.page_indexes.length);
  const anchor=previous?previous.page_indexes.at(-1):following?following.page_indexes[0]:0;
  const page=result.pages[anchor],state=normalizeHtmlState(page.html_state,page,anchor);

  const insertBefore=!previous&&Boolean(following);
  if(freshPages.has(page)&&previous&&!following?.page_indexes.includes(anchor)){
   const matches=(object,key)=>[...freeObjectText(page,object).matchAll(/[^。！？\r\n]+[。！？]?/gu)].some(m=>copyKey(m[0])===key);
   const prev=previous?state.free_objects.map((o,i)=>o.kind==='text'&&matches(o,previous.key)?i:-1).filter(i=>i>=0):[];
   const next=following?state.free_objects.map((o,i)=>o.kind==='text'&&matches(o,following.key)?i:-1).filter(i=>i>=0):[];
   const safe=prev.length<=1&&next.length<=1&&(!prev.length||!next.length||prev[0]<next[0]);
   if(safe){
    let id='confirmed-copy-'+gap.index;while(state.free_objects.some(o=>o.id===id))id+='-copy';
    const node={id,kind:'text',text:gap.text,x:5,y:50,width:90,height:12,font_size:54,font_family:'pingfang',line_height:1.5};
    const nodes=[...state.free_objects],position=prev.length?prev[0]+1:next.length?next[0]:nodes.length;nodes.splice(position,0,node);
    try{const arranged=arrangeEditablePage({...page,html_state:{...state,free_objects:normalizeFreeObjects(nodes)}},anchor,{measureText});freshPages.delete(page);freshPages.add(arranged);result={...result,pages:result.pages.map((p,i)=>i===anchor?arranged:p)};continue;}
    catch(error){if(error.code!=='EDITABLE_LAYOUT_NEEDS_SPLIT')throw error;}
   }
  }

  if(repairPages.has(page)){
   const body=state.free_objects?.find(o=>o.binding==='body'&&o.opacity!==0);let patched;
   if(body){
    const raw=String(page.body||''),nextSpan=following?[...raw.matchAll(/[^。！？\r\n]+[。！？]?/gu)].find(m=>copyKey(m[0])===following.key):null;
    const position=nextSpan?nextSpan.index:insertBefore?0:raw.length;
    // These are newly-created continuation paragraphs, not user-authored spacing.
    // A single separator avoids spending a full empty text line per restored sentence.
    patched={...page,body:[raw.slice(0,position),gap.text,raw.slice(position)].filter(Boolean).join('\n')};
   }
   else{
    let id='confirmed-copy-'+gap.index;while(state.free_objects.some(o=>o.id===id))id+='-copy';
    const node={id,kind:'text',text:gap.text,x:5,y:50,width:90,height:12,font_size:54,font_family:'pingfang',line_height:1.5};
    const nodes=insertBefore?[node,...state.free_objects]:[...state.free_objects,node];
    patched={...page,html_state:{...state,free_objects:normalizeFreeObjects(nodes)}};
   }
   try{const arranged=arrangeEditablePage(patched,anchor,{measureText});repairPages.delete(page);repairPages.add(arranged);result={...result,pages:result.pages.map((p,i)=>i===anchor?arranged:p)};continue;}
   catch(error){if(error.code!=='EDITABLE_LAYOUT_NEEDS_SPLIT')throw error;}
  }
  if(previous&&following&&previous.page_indexes.some(i=>following.page_indexes.includes(i))&&!repairPages.has(page)){const error=new Error('缺句位于同一已有文本框中间，请先拆页再补齐；未改变原文顺序或已有排版。');error.code='CONFIRMED_COPY_SEQUENCE_CONFLICT';throw error;}
  if(result.pages.length>=8){const error=new Error('已确认全文还有内容未进入画布，但已达8页。请先腾出页面；未缩小字号、未删除图文。');error.code='CONFIRMED_COPY_PAGE_LIMIT';error.missing=gap.text;throw error;}
  // Keep the neighbouring illustration, including its source/scene identity.
  // The continuation is a normal page, not a hidden transcript or second draft.
  const image=state.free_objects.find(o=>o.kind==='image'&&o.opacity!==0),imageStyle=image?freeObjectImage(page,image):null;
  const heading=gap.text.split(/[，,；;：:]/u)[0].replace(/^(?:先|接着|然后|最后)\s*/u,'').slice(0,24)||'继续读下去';
  // A repaired page is part of the article, not a transcript patch. Give it a
  // stable narrative role marker derived from source position instead of the
  // old repeated placeholder "原文补充", which made adjacent pages read like
  // mechanical PPT continuation cards.
  const sourceCount=Math.max(1,audit.segments.length),ratio=sourceCount>1?gap.index/(sourceCount-1):0.5;
  const eyebrow=ratio<0.2?'开场':ratio<0.45?'展开':ratio<0.7?'过程':ratio<0.9?'提醒':'收束';
  const continuation={...page,title:heading,eyebrow,body:gap.text,info_panels:[],highlight_phrases:[],layout_ir:null,layout_recipe:null,editor_state:undefined,editor_mode:'html',html_state:undefined,page_role:'method',visual:imageStyle?.src?'character':'none',image_style:{...(imageStyle||page.image_style),hidden:!imageStyle?.src}};
  const position=insertBefore?anchor:anchor+1;const added=arrangeEditablePage(continuation,position,{measureText}),pages=[...result.pages];pages.splice(position,0,added);repairPages.add(added);
  result={...result,pages,visible_pages:result.visible_pages+1,stage:'LOCAL_DRAFT'};
 }
 const remaining=confirmedCopyCoverage(result).missing;
 if(remaining.length){const error=new Error('全文校对没有通过，已保留原稿，未提交不完整排版。');error.code='CONFIRMED_COPY_COVERAGE_INCOMPLETE';throw error;}
 return invalidateVisualReview(result);
}


// Initial narrative materialization only. Model page bodies are planning hints,
// never a second authoritative article. Preserve the confirmed text verbatim,
// give every occurrence one ordered home, and leave existing edited pages alone.
export function materializeGeneratedCopy(content,{measureText}={}){
 const fail=(code,message)=>{const error=new Error(message);error.code=code;throw error;};
 const original=content?.pages||[],native=original.map(p=>Boolean(p.html_state?.free_objects?.length));
 if(native.some(Boolean)){
  if(native.every(Boolean))return content;
  fail('GENERATED_COPY_ALREADY_EDITABLE','已有页面包含手工对象，未重新分配正文；请保留原稿后单独编辑。');
 }
 if(content?.generation?.mode!=='PROVIDER'||content.generation.production_mode!=='narrative'||original.some(p=>p.info_panels?.length))return reconcileConfirmedCopy(content,{measureText});
 const source=String(content.body||'');
 let spans=source.match(/[^。！？\r\n]+[。！？]*(?:\r\n|\r|\n)*|[。！？\r\n]+/gu)||[];
 if(original.length<1||original.length>8||content.visible_pages!==original.length||source.length>6000||spans.length>256)fail('GENERATED_COPY_ALIGNMENT_LIMIT','原文或页面超过本轮排版范围，已保留生成结果，未截断正文。');
 if(!source.trim()||spans.join('')!==source)fail('GENERATED_COPY_ALIGNMENT_UNCONFIRMED','无法确认原文边界，已保留生成结果，未改写正文。');
 // The cover is a title and a scene, not a duplicate summary before page 2.
 const cover=original.length>1,targets=cover?original.slice(1):original;
 let coverCopy='';
 if(cover){
  // A genuinely literal opening on the cover is allowed; a paraphrased hook
  // must not become a repeated second article ahead of the source steps.
  const key=value=>String(value||'').replace(/\s/gu,'');let prefix='';
  for(let n=1;n<=spans.length-targets.length;n++){
   prefix+=spans[n-1];if(key(prefix)!==key(original[0].body))continue;
   // Keep only as much literal opening as the real cover can display. The
   // remainder stays in the original ordered source queue, never disappears.
   for(let take=n;take>=1;take--){const text=spans.slice(0,take).join('');try{arrangeEditablePage({...original[0],body:text},0,{measureText});coverCopy=text;spans=spans.slice(take);break;}catch(error){if(error.code!=='EDITABLE_LAYOUT_NEEDS_SPLIT')throw error;}}
   break;
  }
 }
 if(spans.length<targets.length)fail('GENERATED_COPY_ALIGNMENT_UNCONFIRMED','正文段落少于图文页，未复制句子来凑页数；请减少页面或手工分配。');
 const grams=value=>{const terms=new Set();for(const word of String(value||'').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[])for(let size=2;size<=3;size++)for(let i=0;i+size<=word.length;i++)terms.add(word.slice(i,i+size));return terms;};
 const anchors=targets.map(p=>grams([p.title,p.body,p.visual_action,p.image_prompt].join('\n'))),tokens=spans.map(grams),weight=new Map();
 for(const terms of tokens)for(const term of terms)weight.set(term,1/Math.max(1,anchors.filter(a=>a.has(term)).length));
 const scores=tokens.map(terms=>anchors.map(anchor=>[...terms].reduce((sum,t)=>sum+(anchor.has(t)?weight.get(t):0),0)/Math.max(1,[...terms].reduce((sum,t)=>sum+weight.get(t),0))));
 const n=spans.length,m=targets.length,dp=Array.from({length:m+1},()=>Array(n+1).fill(null));dp[0][0]={score:0,cuts:[]};
 // Monotone contiguous partition: no swapping, omission or duplicated source.
 // Lexical overlap is a conservative relevance signal, NOT semantic proof.
 for(let p=0;p<m;p++)for(let from=p;from<n;from++)if(dp[p][from]){
  let agreement=0,score=0;
  for(let to=from+1;to<=n-(m-p-1);to++){
   const length=spans[to-1].replace(/\s/g,'').length;agreement+=scores[to-1][p];score+=scores[to-1][p]*length;
   if(m>1&&agreement/(to-from)<0.06)continue;
   const value=dp[p][from].score+score;
   if(!dp[p+1][to]||dp[p+1][to].score<value)dp[p+1][to]={score:value,cuts:[...dp[p][from].cuts,{from,to}]};
  }
 }
 const chosen=dp[m][n];if(!chosen)fail('GENERATED_COPY_ALIGNMENT_UNCONFIRMED','正文与分镜缺少可确认的对应关系，已保留图片和原文，未猜测或重复补页。');
 const pages=[];
 const continuationHeading=body=>{
  const first=String(body||'').replace(/\s+/gu,' ').trim().split(/[。！？；;，,：:]/u)[0].replace(/^(?:第[一二三四五六七八九十\d]+步[，,:：]?|先|接着|然后|最后)\s*/u,'').trim();
  return (first||'继续往下看').slice(0,18);
 };
 const compose=(page,body,index,continuation=false)=>{
  const next=continuation?{
   ...page,body,title:continuationHeading(body),eyebrow:'继续往下看',visual_action:'',image_prompt:'',visual:'none',
   image_style:{...(page.image_style||{}),src:'',hidden:true},highlight_phrases:[],html_state:undefined,layout_ir:null,layout_recipe:null,editor_mode:'html',
  }:{...page,body,highlight_phrases:(page.highlight_phrases||[]).filter(x=>(page.title+'\n'+body).includes(x))};
  return arrangeEditablePage(next,index,{measureText});
 };
 if(cover)pages.push(compose(original[0],coverCopy,0));
 for(let i=0;i<m;i++){
  const {from,to}=chosen.cuts[i];let cursor=from,part=0;
  while(cursor<to){
   if(pages.length>=8)fail('GENERATED_COPY_PAGE_LIMIT','原文在手机字号下超过8页，未缩字、删文或重新生图。');
   let accepted=null,end=cursor,lastError;
   for(let j=cursor+1;j<=to;j++){
    try{const candidate=compose(targets[i],spans.slice(cursor,j).join(''),pages.length,part>0);accepted=candidate;end=j;}
    catch(error){if(error.code!=='EDITABLE_LAYOUT_NEEDS_SPLIT')throw error;lastError=error;break;}
   }
   if(!accepted)throw lastError||new Error('GENERATED_COPY_LAYOUT_UNCONFIRMED');
   pages.push(accepted);cursor=end;part++;
  }
 }
 if(pages.map(p=>p.body).join('')!==source)fail('GENERATED_COPY_SEQUENCE_INVALID','正文顺序校验未通过，未提交本次排版。');
 const result=invalidateVisualReview({...content,pages,visible_pages:pages.length});
 if(confirmedCopyCoverage(result).missing.length)fail('GENERATED_COPY_SEQUENCE_INVALID','画布正文校验未通过，未提交本次排版。');
 return result;
}
