import assert from 'node:assert/strict';
import test from 'node:test';
import {createCryptoClient} from '../lib/crypto-sources.ts';

const start=Date.UTC(2026,10,21);
const now=()=>start+2*86400000;
const full=Array.from({length:1442},(_,i)=>start+(i-1)*60000);
const row=(time:number)=>[String(time),'100','110','90','101','2'];
type TestProvider='Binance'|'OKX'|'Bitget'|'Bybit';
const hosts:Record<TestProvider,string>={Binance:'data-api.binance.vision',OKX:'www.okx.com',Bitget:'api.bitget.com',Bybit:'api.bybit.com'};
const directories={
  Binance:{symbols:[{symbol:'BTCUSDT',status:'TRADING',baseAsset:'BTC',quoteAsset:'USDT'}]},
  OKX:{code:'0',data:[{state:'live',baseCcy:'BTC',quoteCcy:'USDT',instId:'BTC-USDT'}]},
  Bitget:{code:'00000',data:[{status:'online',baseCoin:'BTC',quoteCoin:'USDT',symbol:'BTCUSDT'}]},
  Bybit:{retCode:0,result:{category:'spot',list:[{status:'Trading',baseCoin:'BTC',quoteCoin:'USDT',symbol:'BTCUSDT'}]}},
};

for(const provider of ['Binance','OKX','Bitget','Bybit'] as const){
  test(`${provider} reads an exact historical 1d window in bounded 1m pages without fetching any other venue`,async()=>{
    const pages:URL[]=[];
    const id=provider==='OKX'?'BTC-USDT':'BTCUSDT',source=`${provider} 公共现货行情 · ${id}`;
    const client=createCryptoClient(async input=>{
      const url=new URL(input),params=url.searchParams;
      assert.equal(url.hostname,hosts[provider]);
      if(/exchangeInfo|instruments|symbols/.test(url.pathname))return Response.json(directories[provider]);
      const limit=Number(params.get('limit'));
      pages.push(url);
      if(provider==='Binance'||provider==='Bybit'){
        const binance=provider==='Binance';
        assert.equal(params.get('interval'),binance?'1m':'1');
        assert.equal(params.get('symbol'),id);
        assert.ok(limit<=1000);
        const candles=full.filter(time=>time>=Number(params.get(binance?'startTime':'start'))&&time<=Number(params.get(binance?'endTime':'end')));
        return binance?Response.json(candles.slice(0,limit).map(time=>[...row(time),time+59999])):
          Response.json({retCode:0,result:{category:'spot',symbol:id,list:candles.reverse().slice(0,limit).map(row)}});
      }
      if(provider==='OKX'){
        assert.equal(url.pathname,'/api/v5/market/history-candles');
        assert.equal(params.get('instId'),id);
        assert.equal(params.get('bar'),'1m');
        assert.ok(limit<=300);
        return Response.json({code:'0',data:full.filter(time=>time<Number(params.get('after'))).reverse().slice(0,limit)
          .map(time=>[...row(time),'0','0','1'])});
      }
      assert.equal(url.pathname,'/api/v2/spot/market/history-candles');
      assert.equal(params.get('granularity'),'1min');
      assert.equal(params.get('symbol'),id);
      assert.ok(limit<=200);
      return Response.json({code:'00000',data:full.filter(time=>time<=Number(params.get('endTime'))).reverse().slice(0,limit).map(row)});
    },now);
    const data=await client.getCryptoMinuteWindow('BTCUSDT',source,start/1000,(start+86400000)/1000);
    assert.equal(data.source,source);
    assert.equal(data.interval,'1m');
    assert.equal(pages.length,{Binance:2,OKX:5,Bitget:8,Bybit:2}[provider]);
    assert.deepEqual(data.candles.map(c=>c.time),full.slice(1,-1).map(time=>time/1000));
    assert.ok(data.candles.every(c=>c.closed===true));
  });
}

test('a Kraken minute window is restricted to its own recent OHLC and never fabricated from another venue',async()=>{
  const calls:URL[]=[];
  const client=createCryptoClient(async input=>{
    const url=new URL(input);
    assert.equal(url.hostname,'api.kraken.com');
    calls.push(url);
    return url.pathname.endsWith('AssetPairs')
      ?Response.json({error:[],result:{XBTUSDT:{altname:'XBTUSDT',wsname:'XBT/USDT'}}})
      :Response.json({error:[],result:{XBTUSDT:full.slice(-720).map(time=>[time/1000,'100','110','90','101','0','2','5'])}});
  },now);
  const data=await client.getCryptoMinuteWindow('BTCUSDT','Kraken 公共现货行情 · XBTUSDT',start/1000,(start+86400000)/1000);
  assert.equal(calls.length,2);
  assert.equal(calls[1].searchParams.get('interval'),'1');
  assert.ok(data.candles.length>0&&data.candles.length<1440);
  assert.ok(data.candles.every(c=>c.closed===true&&c.time<(start+86400000)/1000));
});

test('source mismatch cannot fall over and invalid or oversized ranges make no network request',async()=>{
  let calls=0;
  const client=createCryptoClient(async input=>{
    calls++;
    assert.equal(new URL(input).hostname,hosts.Binance);
    return Response.json(directories.Binance);
  },now);
  const a=start/1000;
  const source='Binance 公共现货行情 · BTCUSDT';
  for(const [first,last] of [[a+1,a+300],[a,a+86460],[a,a],[a,a+301],[now()/1000,now()/1000+60]])
    await assert.rejects(client.getCryptoMinuteWindow('BTCUSDT',source,first,last),{status:400});
  await assert.rejects(client.getCryptoMinuteWindow('BTCUSDT','Unrecognized feed',a,a+300),{status:400});
  assert.equal(calls,0);
  await assert.rejects(client.getCryptoMinuteWindow('BTCUSDT','Binance 公共现货行情 · BTCUSD',a,a+300),{status:404});
  assert.equal(calls,1);
});
