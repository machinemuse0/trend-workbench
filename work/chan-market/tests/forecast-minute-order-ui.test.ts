import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import {build} from 'esbuild';
import {createElement,type ComponentType} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ForecastJournal,ForecastRecord} from '../lib/forecast-journal';
import type {MarketData} from '../lib/market-types';

test('the minute check appears inside an eligible ambiguous forecast and is absent for other records',async()=>{
  const project=fileURLToPath(new URL('../',import.meta.url));
  const bundle=await build({
    absWorkingDir:project,entryPoints:['components/forecast-activity.tsx'],bundle:true,write:false,
    platform:'node',format:'cjs',packages:'external',alias:{'@':project},jsx:'automatic',
  });
  const compiled={exports:{} as {default:ComponentType<{
    journal:ForecastJournal;data:MarketData|null;notices:[];saved:boolean;
  }>}};
  compileFunction(bundle.outputFiles[0].text,['module','exports','require'])(compiled,compiled.exports,createRequire(import.meta.url));
  const barTime=Date.UTC(2026,10,21)/1000;
  const source='Binance 公共现货行情 · BTCUSDT',adjustment='原始成交价格，不复权';
  const anchor={price:100,source:'confirmed-fractal' as const,estimated:false,time:barTime-1200,index:1,confirmedAt:2};
  const record:ForecastRecord={
    id:'example',key:`crypto|BTCUSDT|5m|${source}|${adjustment}`,market:'crypto',symbol:'BTCUSDT',interval:'5m',source,adjustment,
    createdAt:barTime-600,referencePrice:100,referenceTime:barTime-900,structureAsOf:barTime-600,
    outlook:{id:'long',side:'long',status:'ready',kind:'breakout',triggerRule:'close-above',zoneLow:99,zoneHigh:101,triggerPrice:100,
      invalidationPrice:90,anchor,targets:[{...anchor,price:110},{...anchor,price:120}],basis:['confirmed-fractal']},
    lastBarTime:barTime,lastClose:100,barsObserved:1,status:'ambiguous',
    events:[{id:'ambiguous',type:'ambiguous',at:barTime+300,barTime,price:100}],
  };
  const data:MarketData={
    instrument:{id:'crypto:BTCUSDT',market:'crypto',symbol:'BTCUSDT',exchange:'Binance',currency:'USDT',name:'Bitcoin'},
    interval:'5m',source,adjustment,candles:[],asOf:new Date(barTime*1000).toISOString(),warnings:[],delayNotice:'',availableIntervals:['5m'],
  };
  const render=(entry:ForecastRecord,market=data)=>renderToStaticMarkup(createElement(compiled.exports.default,{
    journal:{version:1,records:[entry],trimmed:0},data:market,notices:[],saved:true,
  }));
  assert.match(render(record),/<details class="forecast-record">.*先后不明.*<button type="button">用 1 分钟 K 线核对先后<\/button>.*<\/details>/);
  assert.doesNotMatch(render({...record,status:'invalidated'}),/用 1 分钟 K 线核对先后/);
  const weekly={...record,key:`crypto|BTCUSDT|1w|${source}|${adjustment}`,interval:'1w' as const};
  assert.doesNotMatch(render(weekly,{...data,interval:'1w'}),/用 1 分钟 K 线核对先后/);
});
