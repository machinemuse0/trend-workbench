import assert from 'node:assert/strict';
import test from 'node:test';
import {checkForecastMinuteOrder,forecastMinuteWindow,loadForecastMinuteOrder} from '../lib/forecast-minute-order.ts';
import {forecastStats,type ForecastEvent,type ForecastRecord} from '../lib/forecast-journal.ts';
import type {Candle,Interval,MarketData} from '../lib/market-types.ts';

const start=Date.UTC(2026,10,21)/1000;
const level=(price:number)=>({price,source:'confirmed-fractal' as const,estimated:false,time:start-600,index:3,confirmedAt:5});
const event=(type:ForecastEvent['type'],barTime:number,at:number):ForecastEvent=>({id:type,type,barTime,at,price:100});
const record:ForecastRecord={
  id:'case',key:'crypto|BTCUSDT|5m|Binance 公共现货行情 · BTCUSDT|原始成交价格，不复权',
  market:'crypto',symbol:'BTCUSDT',interval:'5m',source:'Binance 公共现货行情 · BTCUSDT',adjustment:'原始成交价格，不复权',
  createdAt:start-900,referencePrice:100,referenceTime:start-1200,structureAsOf:start-900,
  outlook:{id:'long',status:'ready',side:'long',kind:'breakout',zoneLow:99,zoneHigh:101,triggerPrice:100,
    invalidationPrice:90,targets:[level(110),level(120)],anchor:level(100),basis:['confirmed-fractal'],triggerRule:'close-above'},
  lastBarTime:start,lastClose:100,barsObserved:3,status:'ambiguous',
  events:[event('condition-met',start-600,start-300),event('ambiguous',start,start+300)],
};
const minute=(i:number,patch:Partial<Candle>={}):Candle=>({
  time:start+i*60,open:100,close:100,high:101,low:99,volume:1,closed:true,...patch,
});
const market=(candles:Candle[]):MarketData=>({
  instrument:{id:'crypto:BTCUSDT',market:'crypto',symbol:'BTCUSDT',exchange:'Binance',name:'Bitcoin',currency:'USDT'},
  interval:'1m',candles,source:record.source,adjustment:record.adjustment,asOf:new Date((start+90000)*1000).toISOString(),
  delayNotice:'',warnings:[],availableIntervals:['1m'],
});

test('only an ambiguous 5m through 1d crypto record produces its exact original candle window',()=>{
  for(const [interval,span] of Object.entries({'5m':300,'15m':900,'30m':1800,'1h':3600,'4h':14400,'1d':86400})){
    const candidate={...record,interval:interval as Interval,events:[event('ambiguous',start,start+span)]};
    assert.deepEqual(forecastMinuteWindow(candidate),{start,end:start+span});
    assert.equal(forecastMinuteWindow({...candidate,events:[event('ambiguous',start,start+span+1)]}),null);
  }
  for(const interval of ['1m','1w','1M'] as const)assert.equal(forecastMinuteWindow({...record,interval}),null);
  assert.equal(forecastMinuteWindow({...record,market:'us'}),null);
  assert.equal(forecastMinuteWindow({...record,status:'invalidated'}),null);
  assert.equal(forecastMinuteWindow({...record,source:'Imported CSV'}),null);
});

test('orders distinct minute touches for both directions and leaves same-minute ties unknown',()=>{
  const candidate=market([minute(0,{open:90,close:90,high:90,low:90,volume:0}),minute(1,{high:110}),minute(2),minute(3,{low:90}),minute(4)]);
  const snapshot=structuredClone(record);
  assert.deepEqual(checkForecastMinuteOrder(record,candidate),{
    status:'target-first',stopAt:start+180,targetAt:start+60,target:1,conditionConfirmed:true,
  });
  const short:ForecastRecord={...record,outlook:{...record.outlook,side:'short',invalidationPrice:110,targets:[level(90),level(80)],triggerRule:'close-below'}};
  assert.deepEqual(checkForecastMinuteOrder(short,candidate),{
    status:'stop-first',stopAt:start+60,targetAt:start+180,target:1,conditionConfirmed:true,
  });
  candidate.candles[1].low=90;
  assert.equal(checkForecastMinuteOrder(record,candidate).status,'same-minute');
  assert.deepEqual(record,snapshot);
  assert.equal(forecastStats([record]).resolved,0);
});

test('missing, duplicate, unconfirmed and foreign venue minutes cannot justify an order',()=>{
  const data=market([minute(0,{high:110}),minute(1,{low:90}),minute(2),minute(3),minute(4)]);
  assert.equal(checkForecastMinuteOrder(record,{...data,candles:data.candles.slice(0,-1)}).status,'incomplete');
  assert.equal(checkForecastMinuteOrder(record,{...data,candles:[minute(0),minute(1),minute(1),minute(3),minute(4)]}).status,'incomplete');
  assert.equal(checkForecastMinuteOrder(record,{...data,candles:[...data.candles.slice(0,4),minute(4,{closed:false})]}).status,'incomplete');
  assert.equal(checkForecastMinuteOrder(record,{...data,source:'OKX 公共现货行情 · BTC-USDT'}).status,'unavailable');
  assert.equal(checkForecastMinuteOrder(record,{...data,instrument:{...data.instrument,exchange:'OKX'}}).status,'unavailable');
  assert.equal(checkForecastMinuteOrder(record,{...data,adjustment:'不同价格口径'}).status,'unavailable');
});

test('compares a pending second target after the first was hit and preserves entry ambiguity',()=>{
  const afterFirst={...record,events:[record.events[0],event('target1',start-300,start),record.events[1]]};
  const candles=[minute(0),minute(1,{high:112}),minute(2,{low:90}),minute(3),minute(4)];
  assert.deepEqual(checkForecastMinuteOrder(afterFirst,market(candles)),{
    status:'stop-only',stopAt:start+120,targetAt:null,target:2,conditionConfirmed:true,
  });
  candles[1].high=120;
  assert.equal(checkForecastMinuteOrder(afterFirst,market(candles)).status,'target-first');
  const beforeEntry={...record,events:[record.events[1]]};
  assert.deepEqual(checkForecastMinuteOrder(beforeEntry,market([minute(0,{high:110}),minute(1),minute(2),minute(3),minute(4)])),{
    status:'target-only',stopAt:null,targetAt:start,target:1,conditionConfirmed:false,
  });
});

test('a click requests the exact historical window and source from the record',async()=>{
  const signal=new AbortController().signal;
  const outcome=await loadForecastMinuteOrder(record,signal,async(input,init)=>{
    const request=new URL(String(input),'http://workbench.test');
    assert.equal(request.pathname,'/api/forecast-minute-window');
    assert.deepEqual(Object.fromEntries(request.searchParams),{symbol:record.symbol,source:record.source,start:String(start),end:String(start+300)});
    assert.equal(init?.signal,signal);
    return Response.json(market([minute(0,{low:90}),minute(1,{high:110}),minute(2),minute(3),minute(4)]));
  });
  assert.equal(outcome.status,'stop-first');
  assert.deepEqual(await loadForecastMinuteOrder(record,signal,async()=>new Response(null,{status:404})),{status:'unavailable'});
});
