const ROUTES = Object.freeze({
  wellness: [
    [/养生|调养|调理|养胃|润燥|秋燥|寒湿|脾胃|失眠|睡眠|久咳|疼痛|酸痛|发紧|口干|咽干|喉咙|反酸|胃不舒服|肠胃不适|身体不适|呼吸不畅/u, 6, 'health-state'],
    [/处暑|白露|节气|犯困|肩颈|眼睛|久坐|舒缓|食疗|薏米|银耳|百合|温水/u, 3, 'wellness-context'],
  ],
  culture: [
    [/茶艺|茶文化|茶席|茶器|品茗|泡茶|冲泡|公道杯|茶碗|茶汤|香道|书法|器物/u, 6, 'culture-object'],
    [/中日|传统文化|东方生活|手作|非遗|古典|礼仪/u, 3, 'culture-context'],
  ],
  relationships: [
    [/暧昧|恋爱|伴侣|婚姻|分手|前任|约会|亲密关系|边界感|回避型|依恋/u, 6, 'relationship-signal'],
    [/关系|人性|朋友|友情|相处|沟通/u, 3, 'relationship-context'],
  ],
  growth: [
    [/成长|拖延|自律|效率|职场|工作|学习|认知|目标|选择|复盘|执行力/u, 4, 'growth-signal'],
    [/休息|焦虑|内耗|动力|习惯/u, 3, 'growth-context'],
  ],
  identity: [
    [/小红书|自媒体|内容创作|涨粉|人设|个人IP|账号运营|账号成长|选题运营|笔记发布|内容发布/u, 6, 'identity-signal'],
    [/博主|栏目|流量|粉丝|笔记/u, 3, 'identity-context'],
  ],
  academy: [
    [/书院|招生|学员|课程|教学|武术教育|禅修课程/u, 6, 'academy-signal'],
    [/课堂|老师|学生|教案/u, 3, 'academy-context'],
  ],
  daoism: [
    [/道德经|老子|庄子|道家|道教|修道|道法/u, 6, 'daoism-signal'],
    [/无为|上善若水|阴阳/u, 3, 'daoism-context'],
  ],
});

const VALID = new Set(Object.keys(ROUTES));

export function inferContentPillar(value, { fallback = 'culture' } = {}) {
  const text = String(value || '').trim();
  const safeFallback = VALID.has(String(fallback)) ? String(fallback) : 'culture';
  if (!text) return { pillar: safeFallback, confident: false, score: 0, margin: 0, reasons: [] };
  const ranked = Object.entries(ROUTES).map(([pillar, rules]) => {
    let score = 0; const reasons = [];
    for (const [pattern, weight, reason] of rules) {
      if (!pattern.test(text)) continue;
      score += weight; reasons.push(reason);
    }
    return { pillar, score, reasons };
  }).sort((a,b)=>b.score-a.score || a.pillar.localeCompare(b.pillar));
  const best=ranked[0],second=ranked[1];
  if (!best || best.score === 0) return { pillar: safeFallback, confident: false, score: 0, margin: 0, reasons: [] };
  const margin=best.score-(second?.score||0);
  // Strong single-domain evidence or two neighboring signals are enough;
  // ambiguous mixed topics stay on the user's current route.
  const confident=best.score>=6 && margin>=2;
  return { pillar: confident?best.pillar:safeFallback, confident, score: best.score, margin, reasons: [...best.reasons] };
}
