import { mediaPolicyFor, panelPreferredAspect } from "./media-role.mjs";
import { designProgramLayout, normalizeDesignProgram } from "./design-program.mjs";

export const HTML_LAYOUT_STATE_VERSION = 12;
const HTML_ROLE_LAYOUT_MIGRATION_VERSION = 9;
export const HTML_IMAGE_FOCAL_MIN = 12;
export const HTML_IMAGE_FOCAL_MAX = 88;
export const HTML_IMAGE_ZOOM_MAX = 1.8;

export const HTML_LAYOUTS = Object.freeze([
  { id: "cover-poster", label: "大字场景封面", note: "标题先赢，完整场景托住下半场" },
  { id: "editorial-notes", label: "主次长文", note: "一组主内容领读，两组内容自然承接" },
  { id: "visual-story", label: "图像叙事", note: "一张主图带出一段故事" },
  { id: "spatial-list", label: "纵向三段", note: "三组图文顺着手机阅读，不做缩略卡片" },
]);

const HTML_LAYOUT_IDS = new Set(HTML_LAYOUTS.map((layout) => layout.id));
const EDITOR_MODES = new Set(["html", "fabric"]);

function finite(value, fallback, low, high) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
}

export function editorModeForPage(page) {
  if (EDITOR_MODES.has(page?.editor_mode)) return page.editor_mode;
  return page?.editor_state?.__xsm_editor_version ? "fabric" : "html";
}

export function recommendHtmlLayout(page, pageIndex = 0) {
  const role = String(page?.page_role || "").toLowerCase();
  const panelCount = Array.isArray(page?.info_panels) ? page.info_panels.length : 0;
  if (pageIndex === 0 || role === "hook") return "cover-poster";
  if (role === "closing" && panelCount <= 1) return "visual-story";
  if (["method", "checklist", "pitfall"].includes(role) && panelCount >= 3) {
    return pageIndex % 2 === 0 ? "editorial-notes" : "spatial-list";
  }
  if (panelCount >= 3) return "editorial-notes";
  if (page?.visual === "character" || panelCount === 1) return "visual-story";
  return panelCount >= 2 ? "editorial-notes" : "spatial-list";
}

export function editorialPanelMeta(page) {
  const panels = Array.isArray(page?.info_panels) ? page.info_panels : [];
  const requestedHeroIndex = panels.findIndex((panel) => panel?.content_role === "hero");
  const heroIndex = requestedHeroIndex >= 0 ? requestedHeroIndex : 0;
  return panels.map((panel, index) => {
    const contentRole = index === heroIndex ? "hero" : panel?.content_role === "detail" ? "detail" : "support";
    const shotRole = ["scene", "action", "detail", "comparison"].includes(panel?.shot_role)
      ? panel.shot_role
      : index === heroIndex ? "scene" : index === panels.length - 1 ? "detail" : "action";
    const policy = mediaPolicyFor({ ...panel, content_role: contentRole, shot_role: shotRole });
    return {
      contentRole,
      shotRole,
      mediaRole: policy.mediaRole,
      fitPolicy: policy.fitPolicy,
      preferredAspect: panelPreferredAspect(panels.length),
      highlightPhrases: Array.isArray(panel?.highlight_phrases) ? panel.highlight_phrases : [],
    };
  });
}

export function recommendHtmlDensity(page) {
  const panels = Array.isArray(page?.info_panels) ? page.info_panels : [];
  const copyLength = String(page?.title || "").length
    + String(page?.body || "").length
    + panels.reduce((sum, panel) => sum + String(panel?.title || "").length + String(panel?.body || "").length, 0);
  if (copyLength > 260 || panels.length >= 4) return "compact";
  if (copyLength < 118 && panels.length <= 3) return "airy";
  return "balanced";
}

export function highlightTextSegments(value, phrases = []) {
  const text = String(value || "");
  const candidates = [...new Set((Array.isArray(phrases) ? phrases : []).map((item) => String(item || "").trim()).filter((item) => item.length >= 2 && text.includes(item)))]
    .sort((first, second) => second.length - first.length);
  if (!candidates.length) return [{ text, highlight: false }];
  const ranges = [];
  candidates.forEach((phrase) => {
    let start = text.indexOf(phrase);
    while (start >= 0) {
      const end = start + phrase.length;
      if (!ranges.some((range) => start < range.end && end > range.start)) ranges.push({ start, end });
      start = text.indexOf(phrase, start + phrase.length);
    }
  });
  ranges.sort((first, second) => first.start - second.start);
  const segments = [];
  let cursor = 0;
  ranges.forEach((range) => {
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), highlight: false });
    segments.push({ text: text.slice(range.start, range.end), highlight: true });
    cursor = range.end;
  });
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlight: false });
  return segments;
}

function semanticTitleChunks(value, limit) {
  const text = String(value || "");
  const length = [...text].length;
  if (!text || length <= limit || /\s/u.test(text) || typeof Intl?.Segmenter !== "function") return [text];
  const words = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)]
    .map((item) => item.segment)
    .filter(Boolean);
  if (words.length < 2 || words.some((word) => [...word].length > limit)) return [text];
  const lineCount = Math.ceil(length / limit);
  const idealLength = length / lineCount;
  const states = Array.from({ length: lineCount + 1 }, () => new Map());
  states[0].set(0, { score: 0, chunks: [] });
  for (let line = 0; line < lineCount; line += 1) {
    states[line].forEach((state, start) => {
      let chunk = "";
      for (let end = start; end < words.length; end += 1) {
        chunk += words[end];
        const chunkLength = [...chunk].length;
        if (chunkLength > limit) break;
        const wordsLeft = words.length - end - 1;
        const linesLeft = lineCount - line - 1;
        if (wordsLeft < linesLeft) continue;
        const nextScore = state.score + ((chunkLength - idealLength) ** 2);
        const previous = states[line + 1].get(end + 1);
        if (!previous || nextScore < previous.score) {
          states[line + 1].set(end + 1, { score: nextScore, chunks: [...state.chunks, chunk] });
        }
      }
    });
  }
  return states[lineCount].get(words.length)?.chunks || [text];
}

export function titleTextSegments(value, phrases = [], maxUnbrokenLength = 10) {
  const limit = Math.max(2, Number(maxUnbrokenLength) || 10);
  const segments = [];
  highlightTextSegments(value, phrases).forEach((segment, segmentIndex) => {
    String(segment.text || "").split(/(\s+)/u).filter(Boolean).forEach((text, pieceIndex) => {
      const separator = /^\s+$/u.test(text);
      if (separator) {
        segments.push({ text, highlight: segment.highlight, separator: true, keepTogether: false, breakBefore: false });
        return;
      }
      semanticTitleChunks(text, limit).forEach((chunk, chunkIndex) => {
        segments.push({
          text: chunk,
          highlight: segment.highlight,
          separator: false,
          keepTogether: [...chunk].length <= limit,
          breakBefore: chunkIndex > 0 || (pieceIndex === 0 && segmentIndex > 0),
        });
      });
    });
  });
  return segments;
}

export function layoutsForPage(page) {
  const panelCount = Array.isArray(page?.info_panels) ? page.info_panels.length : 0;
  const eligibleIds = panelCount >= 2
    ? ["editorial-notes", "spatial-list"]
    : panelCount === 1
      ? ["visual-story", "editorial-notes"]
      : ["cover-poster", "visual-story"];
  return eligibleIds.map((id) => HTML_LAYOUTS.find((layout) => layout.id === id));
}

export function normalizeHtmlState(value, page, pageIndex = 0) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceVersion = Number(source.__xsm_html_version || 0);
  const eligibleLayoutIds = new Set(layoutsForPage(page).map((layout) => layout.id));
  const designProgram = normalizeDesignProgram(source.design_program, page, pageIndex);
  const programLayout = designProgramLayout(designProgram, page, pageIndex);
  const recommendedLayout = source.design_program && eligibleLayoutIds.has(programLayout)
    ? programLayout
    : recommendHtmlLayout(page, pageIndex);
  const role = String(page?.page_role || "").toLowerCase();
  const migrateRoleLayout = sourceVersion < HTML_ROLE_LAYOUT_MIGRATION_VERSION
    && (pageIndex === 0 || role === "hook" || role === "closing" || (["method", "checklist", "pitfall"].includes(role) && panelsForMigration(page) >= 3));
  const layoutId = !migrateRoleLayout && HTML_LAYOUT_IDS.has(source.layout_id) && eligibleLayoutIds.has(source.layout_id)
    ? source.layout_id
    : recommendedLayout;
  const imageStyles = new Map();
  const panels = Array.isArray(page?.info_panels) ? page.info_panels : [];
  if (panels.length) panels.forEach((panel, index) => imageStyles.set(`panel-${index}`, { ...panel, ...panel?.image_style }));
  else imageStyles.set("hero", { ...page, ...page?.image_style, content_role: "hero" });
  const imageEdits = {};
  if (source.image_edits && typeof source.image_edits === "object" && !Array.isArray(source.image_edits)) {
    Object.entries(source.image_edits).forEach(([key, edit]) => {
      if (!edit || typeof edit !== "object" || Array.isArray(edit)) return;
      const policy = mediaPolicyFor(imageStyles.get(key) || {});
      const legacyZoom = finite(edit.zoom, policy.defaultZoom, 1, sourceVersion < 4 ? 1.45 : HTML_IMAGE_ZOOM_MAX);
      const migratedZoom = sourceVersion < 4 && [1.04, 1.06, 1.08].includes(Number(legacyZoom.toFixed(2)))
        ? policy.defaultZoom
        : legacyZoom;
      imageEdits[key] = {
        focalX: finite(edit.focalX, 50, HTML_IMAGE_FOCAL_MIN, HTML_IMAGE_FOCAL_MAX),
        focalY: finite(edit.focalY, 50, HTML_IMAGE_FOCAL_MIN, HTML_IMAGE_FOCAL_MAX),
        zoom: finite(
          sourceVersion === 1
            ? ({ "1.08": policy.defaultZoom, "1.12": policy.defaultZoom, "1.18": policy.defaultZoom }[legacyZoom.toFixed(2)] ?? migratedZoom)
            : migratedZoom,
          policy.defaultZoom,
          1,
          HTML_IMAGE_ZOOM_MAX,
        ),
      };
    });
  }
  const objectEdits = {};
  if (source.object_edits && typeof source.object_edits === "object" && !Array.isArray(source.object_edits)) {
    Object.entries(source.object_edits).forEach(([key, edit]) => {
      if (!key || !edit || typeof edit !== "object" || Array.isArray(edit)) return;
      /* v6 stored panel transforms against a width-owned image geometry. Once
         rows became the containment authority those offsets could move art
         across neighbouring copy, so only those stale panel transforms reset. */
      if (sourceVersion < HTML_LAYOUT_STATE_VERSION && /^panel-\d+-(?:image|copy)$/.test(key)) return;
      // v11 makes the title and every panel row structurally contained. Old
      // title offsets were authored against nowrap phrases and can push the
      // whole heading beyond the page even after the new grid is applied.
      if (sourceVersion < HTML_LAYOUT_STATE_VERSION && key === "title-block") return;
      // v9 changes the hook cover from an inset portrait to a full-width 9:8
      // frame. Old transforms were measured against incompatible geometry;
      // reset only those cover objects, then preserve every new free edit.
      if (sourceVersion < 9 && (pageIndex === 0 || role === "hook") && ["title-block", "hero-image", "cover-lede"].includes(key)) return;
      objectEdits[key] = {
        x: finite(edit.x, 0, -24, 24),
        y: finite(edit.y, 0, -18, 18),
        scale: finite(edit.scale, 1, .72, 1.4),
      };
    });
  }
  return {
    __xsm_html_version: HTML_LAYOUT_STATE_VERSION,
    layout_id: layoutId,
    density: sourceVersion >= HTML_LAYOUT_STATE_VERSION && ["airy", "balanced", "compact"].includes(source.density)
      ? source.density
      : recommendHtmlDensity(page),
    design_program: designProgram,
    image_edits: imageEdits,
    object_edits: objectEdits,
    ...(source.free_objects === undefined ? {} : { free_objects: normalizeFreeObjects(source.free_objects) }),
  };
}

function panelsForMigration(page) {
  return Array.isArray(page?.info_panels) ? page.info_panels.length : 0;
}

export function nextHtmlLayout(currentId, page, pageIndex = 0) {
  const eligibleLayouts = layoutsForPage(page);
  const normalized = eligibleLayouts.some((layout) => layout.id === currentId)
    ? currentId
    : recommendHtmlLayout(page, pageIndex);
  const currentIndex = eligibleLayouts.findIndex((layout) => layout.id === normalized);
  return eligibleLayouts[(currentIndex + 1) % eligibleLayouts.length].id;
}

export function imageEditFor(state, imageId, imageStyle = {}) {
  const edit = state?.image_edits?.[imageId] || {};
  const policy = mediaPolicyFor(imageStyle);
  return {
    focalX: finite(edit.focalX ?? imageStyle.focalX, 50, HTML_IMAGE_FOCAL_MIN, HTML_IMAGE_FOCAL_MAX),
    focalY: finite(edit.focalY ?? imageStyle.focalY, 50, HTML_IMAGE_FOCAL_MIN, HTML_IMAGE_FOCAL_MAX),
    zoom: finite(edit.zoom, policy.defaultZoom, 1, HTML_IMAGE_ZOOM_MAX),
  };
}

export function updateImageEdit(state, imageId, patch, page, pageIndex = 0) {
  const normalized = normalizeHtmlState(state, page, pageIndex);
  const panels = Array.isArray(page?.info_panels) ? page.info_panels : [];
  const panelIndex = /^panel-(\d+)$/.exec(String(imageId || ""));
  const panel = panelIndex ? panels[Number(panelIndex[1])] : null;
  const imageStyle = panel ? { ...panel, ...panel.image_style } : { ...page, ...page?.image_style, content_role: "hero" };
  const current = imageEditFor(normalized, imageId, imageStyle);
  return {
    ...normalized,
    image_edits: {
      ...normalized.image_edits,
      [imageId]: {
        focalX: finite(patch.focalX ?? current.focalX, current.focalX, HTML_IMAGE_FOCAL_MIN, HTML_IMAGE_FOCAL_MAX),
        focalY: finite(patch.focalY ?? current.focalY, current.focalY, HTML_IMAGE_FOCAL_MIN, HTML_IMAGE_FOCAL_MAX),
        zoom: finite(patch.zoom ?? current.zoom, current.zoom, 1, HTML_IMAGE_ZOOM_MAX),
      },
    },
  };
}

export function objectEditFor(state, objectId) {
  const edit = state?.object_edits?.[objectId] || {};
  return {
    x: finite(edit.x, 0, -24, 24),
    y: finite(edit.y, 0, -18, 18),
    scale: finite(edit.scale, 1, .72, 1.4),
  };
}

export function objectDragEdit(start, deltaX, deltaY, pageWidth, pageHeight) {
  const origin = start && typeof start === "object" ? start : {};
  return {
    x: finite(Number(origin.x || 0) + Number(deltaX || 0) / Math.max(1, Number(pageWidth || 0)) * 100, 0, -24, 24),
    y: finite(Number(origin.y || 0) + Number(deltaY || 0) / Math.max(1, Number(pageHeight || 0)) * 100, 0, -18, 18),
    scale: finite(origin.scale, 1, .72, 1.4),
  };
}

export function updateObjectEdit(state, objectId, patch, page, pageIndex = 0) {
  const normalized = normalizeHtmlState(state, page, pageIndex);
  const current = objectEditFor(normalized, objectId);
  return {
    ...normalized,
    object_edits: {
      ...normalized.object_edits,
      [objectId]: {
        x: finite(patch.x ?? current.x, current.x, -24, 24),
        y: finite(patch.y ?? current.y, current.y, -18, 18),
        scale: finite(patch.scale ?? current.scale, current.scale, .72, 1.4),
      },
    },
  };
}

export function objectTransformStyle(state, objectId) {
  const edit = objectEditFor(state, objectId);
  return {
    "--object-x": `${edit.x}cqw`,
    "--object-y": `${edit.y}cqh`,
    "--object-scale": edit.scale,
  };
}

export function bodyParagraphs(value) {
  const paragraphs = String(value || "")
    .split(/\n\s*\n|\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : [""];
}


// Optional geometry is part of the existing page, not a parallel document.
export const FREE_FONTS = {
 songti:'"Songti SC", "STSong", "SimSun", serif', heiti:'"Heiti SC", "Microsoft YaHei", sans-serif',
 kaiti:'"Kaiti SC", "KaiTi", serif', fangsong:'"FangSong", "STFangsong", serif',
 yuanti:'"Yuanti SC", "YouYuan", sans-serif', pingfang:'"PingFang SC", "Microsoft YaHei", sans-serif',
};
export function normalizeFreeObjects(value) {
 if(!Array.isArray(value)||value.length>128)throw new TypeError('FREE_OBJECTS_INVALID');
 const seen=new Set();
 return value.map(item=>{
  if(!item||!/^[\w-]{1,120}$/.test(item.id||'')||seen.has(item.id)||!['text','image'].includes(item.kind))throw new TypeError('FREE_OBJECT_INVALID');
  seen.add(item.id);
  const out={id:item.id,kind:item.kind,x:finite(item.x,8,-200,200),y:finite(item.y,8,-200,200),width:finite(item.width,40,.5,400),height:finite(item.height,12,.5,400),rotation:finite(item.rotation,0,-36000,36000),opacity:finite(item.opacity,1,0,1)};
  if(item.kind==='text'){
   if(item.binding&&/^(eyebrow|title|body|panel-\d+-(title|body))$/.test(item.binding))out.binding=item.binding;
   else out.text=String(item.text||'').slice(0,10000);
   out.font_size=finite(item.font_size,42,8,400);out.font_family=Object.hasOwn(FREE_FONTS,item.font_family)?item.font_family:'pingfang';out.font_weight=Number(item.font_weight)>=600?700:400;out.font_style=item.font_style==='italic'?'italic':'normal';
   out.color=/^#[0-9a-f]{6}$/i.test(item.color||'')?item.color:'#292720';out.align=['left','center','right','justify'].includes(item.align)?item.align:'left';out.line_height=finite(item.line_height,1.4,.8,3);out.paragraph_gap=finite(item.paragraph_gap,0,0,120);
  }else{
   out.image_id=String(item.image_id||item.id);out.fit=item.fit==='contain'?'contain':'cover';
   if(/^(hero|panel-\d+)$/.test(item.binding||''))out.binding=item.binding;
   else{const src=String(item.src||'');if(!/^(data:image\/(png|jpeg|webp);base64,|blob:|\/(assets|generated)\/|xiaoshimei-media:\/\/sha256\/|https:\/\/)/i.test(src))throw new TypeError('FREE_IMAGE_SOURCE_INVALID');out.src=src;}
  }
  return out;
 });
}
export function freeObjectText(page,item){
 if(!item?.binding)return String(item?.text||'');
 const panel=/^panel-(\d+)-(title|body)$/.exec(item.binding);
 return String(panel?page?.info_panels?.[Number(panel[1])]?.[panel[2]]||'':page?.[item.binding]||'');
}
export function freeObjectImage(page,item){
 if(!item?.binding)return {src:item?.src};
 return item.binding==='hero'?page?.image_style:page?.info_panels?.[Number(item.binding.replace('panel-',''))]?.image_style;
}
export function updateFreeObject(state,id,patch){
 if(!state?.free_objects?.some(item=>item.id===id))throw new TypeError('FREE_OBJECT_MISSING');
 return {...state,free_objects:normalizeFreeObjects(state.free_objects.map(item=>item.id===id?{...item,...patch}:item))};
}
export function freeTextPatch(page,item,text){
 const value=String(text||'');
 if(!item.binding)return {html_state:updateFreeObject(page.html_state,item.id,{text:value})};
 const panel=/^panel-(\d+)-(title|body)$/.exec(item.binding);
 if(panel)return {info_panels:page.info_panels.map((p,i)=>i===Number(panel[1])?{...p,[panel[2]]:value||'\u70b9\u51fb\u8f93\u5165\u6587\u5b57'}:p)};
 return {[item.binding]:value||(item.binding==='title'?'\u70b9\u51fb\u8f93\u5165\u6807\u9898':item.binding==='eyebrow'?'\u5c0f\u6807\u9898':'\u70b9\u51fb\u8f93\u5165\u6b63\u6587')};
}
export function duplicateFreeObject(page,state,id,newId){
 const item=state.free_objects.find(item=>item.id===id);if(!item)throw new TypeError('FREE_OBJECT_MISSING');
 const copy={...item,id:newId,binding:undefined,x:item.x+2,y:item.y+2};
 if(item.kind==='text')copy.text=freeObjectText(page,item);else{copy.src=freeObjectImage(page,item)?.src;copy.image_id=newId;}
 return {...state,free_objects:normalizeFreeObjects([...state.free_objects,copy]),image_edits:item.kind==='image'?{...state.image_edits,[newId]:{...imageEditFor(state,item.image_id)}}:state.image_edits};
}

export function freeResizeGeometry(item,before,after,direction,pageWidth,pageHeight){
 const theta=item.rotation*Math.PI/180,c=Math.cos(theta),s=Math.sin(theta),rot=(x,y)=>[c*x-s*y,s*x+c*y];
 const ax=-direction[0],ay=item.kind==='text'&&!direction[1]?-1:-direction[1];
 const a=rot(ax*before.width/2,ay*before.height/2),b=rot(ax*after.width/2,ay*after.height/2);
 return {x:(item.x*pageWidth/100+before.width/2+a[0]-b[0]-after.width/2)/pageWidth*100,y:(item.y*pageHeight/100+before.height/2+a[1]-b[1]-after.height/2)/pageHeight*100};
}
