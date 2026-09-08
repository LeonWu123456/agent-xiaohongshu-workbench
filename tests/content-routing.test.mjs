import assert from 'node:assert/strict';
import test from 'node:test';
import { inferContentPillar } from '../src/content-routing.mjs';

test('high-confidence tea and traditional-life topics route to culture instead of wellness', () => {
  for (const topic of [
    '新手区分中日茶艺实用方法',
    '泡茶时怎么区分茶席、茶器与冲泡节奏',
    '第一次学茶艺，怎么观察茶席留白和品茗动作',
  ]) {
    const route = inferContentPillar(topic, { fallback: 'wellness' });
    assert.equal(route.confident, true, topic);
    assert.equal(route.pillar, 'culture', topic);
  }
});

test('explicit body discomfort and seasonal care remain wellness', () => {
  for (const topic of [
    '入秋后犯困口干胃口差，处暑怎么调养',
    '久坐肩颈疼痛，办公室怎么做日常舒缓',
    '盯屏幕久了眼睛发紧，怎么休息更稳妥',
  ]) {
    const route = inferContentPillar(topic, { fallback: 'culture' });
    assert.equal(route.confident, true, topic);
    assert.equal(route.pillar, 'wellness', topic);
  }
});

test('low-confidence wording preserves the current route rather than guessing a new one', () => {
  assert.deepEqual(inferContentPillar('今天想写一点最近的感受', { fallback: 'growth' }), {
    pillar: 'growth', confident: false, score: 0, margin: 0, reasons: [],
  });
});

test('specific route beats broad neighboring words', () => {
  assert.equal(inferContentPillar('茶艺学习里怎么区分中日茶席', { fallback: 'wellness' }).pillar, 'culture');
  assert.equal(inferContentPillar('喝茶后胃不舒服、反酸时要不要继续喝', { fallback: 'culture' }).pillar, 'wellness');
  assert.equal(inferContentPillar('小红书账号选题怎么做成稳定栏目', { fallback: 'culture' }).pillar, 'identity');
  assert.equal(inferContentPillar('暧昧关系里怎么判断对方在回避', { fallback: 'culture' }).pillar, 'relationships');
});

test('generic publishing/tooling words alone do not hijack the content pillar', () => {
  assert.deepEqual(inferContentPillar('中文发布包回读', { fallback: 'wellness' }), {pillar:'wellness',confident:false,score:0,margin:0,reasons:[]});
  assert.deepEqual(inferContentPillar('发布权威同稿回读', { fallback: 'culture' }), {pillar:'culture',confident:false,score:0,margin:0,reasons:[]});
});
