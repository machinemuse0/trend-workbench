import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import test from 'node:test';
import { build, type Plugin } from 'esbuild';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CenterBreakout } from '../lib/center-breakout';

const project = fileURLToPath(new URL('../', import.meta.url));

// The production page starts in Chinese on the server. Supply the English
// context for the second render, just as the language toggle does in the UI.
const englishContext: Plugin = {
  name: 'english-language-context',
  setup(builder) {
    builder.onResolve({filter: /^@\/lib\/language$/}, () => ({path:'language', namespace:'english'}));
    builder.onLoad({filter: /.*/, namespace:'english'}, () => ({
      contents: `export const LanguageProvider = ({children}) => children;
        export const useLanguage = () => ({language:'en', locale:'en-US', setLanguage() {}, t:(_zh,en) => en});`,
    }));
  },
};

// Check the rendered homepage, so an unused constant or a link in a footer
// cannot satisfy the release check. No network or browser is needed.
async function renderHeader(language: 'zh' | 'en') {
  const bundle = await build({
    absWorkingDir: project, entryPoints: ['app/page.tsx'], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', alias: {'@': project},
    jsx: 'automatic', plugins: language === 'en' ? [englishContext] : [],
  });
  const compiled = {exports: {} as {default: ComponentType}};
  compileFunction(bundle.outputFiles[0].text, ['module', 'exports', 'require'])(
    compiled, compiled.exports, createRequire(import.meta.url),
  );
  const html = renderToStaticMarkup(createElement(compiled.exports.default));
  const subtitle = html.match(/class="instrument-identity"[\s\S]*?<p>([\s\S]*?)<\/p>/)?.[1].replace(/<[^>]*>/g, '').trim();
  assert.equal(subtitle, 'Bitcoin', 'The initial BTC subtitle should contain only the asset name.');
  assert.doesNotMatch(html, /\b(?:binance|okx)\b|币安|欧易/i);
  const header = html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];
  assert.ok(header, 'The workbench header is missing.');
  return Array.from(header.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g), ([, attrs, contents]) => ({
    href: attrs.match(/\shref="([^"]*)"/)?.[1],
    text: contents.replace(/<(\w+)\b[^>]*\saria-hidden="true"[^>]*>[\s\S]*?<\/\1>/g, '')
      .replace(/<[^>]*>/g, '').trim(),
  }));
}

for (const language of ['zh', 'en'] as const) {
  test(`official header includes the product name, developer and community destinations (${language})`, async () => {
    const anchors = await renderHeader(language);
    // Expected official identities are independent of the application configuration.
    const required = [
      ['/', language === 'zh' ? '趋势判断工作台' : 'Trend Workbench'],
      ['https://x.com/bi_9527zx', language === 'zh' ? '开发者（DeFi狙击手）' : 'Developer (DeFi狙击手)'],
      ['https://t.me/jujishou9527', language === 'zh' ? '社区交流' : 'Community'],
    ];
    for (const [href, text] of required) {
      assert.deepEqual(anchors.filter(link => link.href === href || link.text === text), [{href, text}],
        `Missing or incorrect official header link for ${text} (${href}).`);
    }
  });
}

test('combined assessment renders the prices, both sides, the period and missing flow in both languages',async()=>{
  const bundle=await build({
    absWorkingDir:project,entryPoints:['components/confluence-panel.tsx'],bundle:true,write:false,
    platform:'node',format:'cjs',packages:'external',alias:{'@':project},jsx:'automatic',
  });
  const compiled={exports:{} as {default:ComponentType<{
    analysis:null;loading:boolean;language:'zh'|'en';breakout?:CenterBreakout|null;
  }>}};
  compileFunction(bundle.outputFiles[0].text,['module','exports','require'])(compiled,compiled.exports,createRequire(import.meta.url));
  const breakout:CenterBreakout={
    layer:'segment',direction:'up',boundary:68000,close:68100,confirmedAt:1795219200,exchange:'Binance',takerBuyShare:.625,
  };
  const render=(language:'zh'|'en',event?:CenterBreakout|null,loading=false)=>
    renderToStaticMarkup(createElement(compiled.exports.default,{analysis:null,loading,language,breakout:event}));
  const zh=render('zh',breakout);
  assert.match(zh,/综合判断.*中枢突破成交/);
  assert.match(zh,/突破价.*68,000 USDT.*确认收盘价.*68,100 USDT/);
  assert.match(zh,/主动买入.*62\.5%.*主动卖出.*37\.5%/);
  assert.match(zh,/统计突破确认 K 线整根的 USDT 成交额/);
  const en=render('en',{...breakout,direction:'down',exchange:'OKX',takerBuyShare:null});
  assert.match(en,/Center breakout flow.*Downward break.*OKX spot.*Active-side split unavailable/);
  assert.doesNotMatch(en,/Active buys|Active sells/);
  assert.match(render('zh',null),/暂无已确认突破/);
  assert.match(render('zh',null,true),/正在识别突破/);
  assert.doesNotMatch(render('zh'),/中枢突破成交/);
});
