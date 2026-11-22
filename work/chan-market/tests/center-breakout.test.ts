import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCenters} from '../lib/chan.ts';
import {findCenterBreakout,supportsCenterBreakout} from '../lib/center-breakout.ts';
import {buildStrokeCenters} from '../lib/center-layers.ts';
import {createCryptoClient} from '../lib/crypto-sources.ts';
import {readMarketResponse} from '../lib/market-response.ts';
import type {Candle,MarketData,StructureLine} from '../lib/market-types.ts';

const start=Date.UTC(2026,10,20)/1000;
const instrument={id:'crypto:BTCUSDT',market:'crypto' as const,symbol:'BTCUSDT',name:'Bitcoin',exchange:'Binance',currency:'USDT'};
const data={instrument,interval:'1h'} satisfies Pick<MarketData,'instrument'|'interval'>;
const bars=(closes:number[]):Candle[]=>closes.map((price,i)=>({
  time:start+i*3600,open:price,high:price+5,low:price-5,close:price,volume:4,closed:true,
}));
const prices=[99,110,100,108];
const segments:StructureLine[]=prices.slice(1).map((price,index)=>({
  from:{index,time:start+index*3600,price:prices[index]},
  to:{index:index+1,time:start+(index+1)*3600,price},
  direction:price>prices[index]?'up':'down',confirmed:true,confirmedAt:index+2,
}));
const analysis={...buildCenters(segments),segments};

test('confirmed inside-to-outside closes use the known segment boundary and actual trade-side share',()=>{
  const candles=bars([104,110,104,109,104,104,111,112,104,96,95]);
  candles[6].takerBuyShare=.625;
  candles[9].takerBuyShare=.2;
  assert.deepEqual(findCenterBreakout(data,candles.slice(0,8),analysis),{
    layer:'segment',direction:'up',boundary:108,close:111,confirmedAt:start+7*3600,exchange:'Binance',takerBuyShare:.625,
  });
  assert.deepEqual(findCenterBreakout(data,candles,analysis),{
    layer:'segment',direction:'down',boundary:100,close:96,confirmedAt:start+10*3600,exchange:'Binance',takerBuyShare:.2,
  });
});

test('excludes breakouts before formation, wicks, boundary touches, open candles and gaps',()=>{
  const candles=bars([104,111,104,111,104,108,112]);
  assert.equal(findCenterBreakout(data,candles.slice(0,6),analysis),null);
  candles[6].closed=false;
  assert.equal(findCenterBreakout(data,candles,analysis),null);
  candles[6].closed=true;
  assert.equal(findCenterBreakout(data,candles.filter((_,i)=>i!==5),analysis),null);
  assert.equal(findCenterBreakout(data,candles,analysis)?.close,112);
});

test('falls back to a confirmed pen center and never borrows active-side data from another venue',()=>{
  const stroke=buildStrokeCenters(segments).at(-1);
  assert.ok(stroke);
  const candles=bars([104,104,104,104,104,112]);
  candles[5].takerBuyShare=0;
  const noSegment={centers:[],segments:[]};
  assert.equal(findCenterBreakout(data,candles,noSegment,stroke)?.layer,'stroke');
  assert.equal(findCenterBreakout(data,candles,noSegment,stroke)?.takerBuyShare,0);
  const backup={...data,instrument:{...instrument,exchange:'OKX'}};
  const breakout=findCenterBreakout(backup,candles,noSegment,stroke);
  assert.equal(breakout?.boundary,108);
  assert.equal(breakout?.takerBuyShare,null);
  candles[5].takerBuyShare=1.1;
  assert.equal(findCenterBreakout(data,candles,noSegment,stroke)?.takerBuyShare,null);
  assert.equal(supportsCenterBreakout({market:'crypto',symbol:'ETHUSDT'}),true);
  assert.equal(supportsCenterBreakout({market:'crypto',symbol:'ETHUSD'}),false);
  assert.equal(findCenterBreakout({...data,instrument:{...instrument,symbol:'SOLUSDT'}},candles,noSegment,stroke),null);
});

test('Binance Spot quote turnover survives the market response and reaches the confirmation candle',async()=>{
  const candles=bars([104,104,104,104,104,105,...Array<number>(30).fill(112)]);
  const rows=candles.map((bar,i)=>[
    bar.time*1000,String(bar.open),String(bar.high),String(bar.low),String(bar.close),'4',(bar.time+3600)*1000-1,
    i===7?'0':'400','4','3',i===6?'250':i===8?'401':i===9?null:i===10?'0':'200','0',
  ]);
  for(const symbol of ['BTCUSDT','ETHUSDT']){
    const client=createCryptoClient(async input=>{
      const url=new URL(input);
      assert.equal(url.hostname,'data-api.binance.vision');
      return new Response(JSON.stringify(url.pathname.endsWith('exchangeInfo')?{
        symbols:[{symbol,status:'TRADING',baseAsset:symbol.slice(0,3),quoteAsset:'USDT'}],
      }:rows));
    },()=> (candles.at(-1)!.time+1800)*1000);
    const market=await client.getCryptoCandles(symbol,'1h',36);
    const wire=await readMarketResponse(new Response(JSON.stringify(market)),{market:'crypto',symbol,interval:'1h'});
    assert.deepEqual(wire.candles.slice(6,11).map(bar=>bar.takerBuyShare),[.625,undefined,undefined,undefined,0]);
    assert.equal(findCenterBreakout(wire,wire.candles,analysis)?.takerBuyShare,.625);
  }
});
