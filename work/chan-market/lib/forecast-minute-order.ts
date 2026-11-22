import type {ForecastRecord} from './forecast-journal';
import type {Interval,MarketData} from './market-types';
import {readMarketResponse} from './market-response.ts';
import {candleAvailableAt} from './timeframe-context.ts';

const supported:ReadonlySet<Interval>=new Set(['5m','15m','30m','1h','4h','1d']);
const spotSource=/^(Binance|OKX|Bitget|Bybit|Kraken) 公共现货行情 · [A-Z0-9-]+$/;

export function forecastMinuteWindow(record:ForecastRecord):{start:number;end:number}|null {
  const event=record.events.at(-1);
  if(record.market!=='crypto'||record.status!=='ambiguous'||event?.type!=='ambiguous'
    ||!supported.has(record.interval)||!spotSource.test(record.source)||!Number.isSafeInteger(event.barTime)
    ||event.barTime<=0||event.barTime%60!==0)return null;
  const end=candleAvailableAt({time:event.barTime},'crypto',record.interval);
  return event.at===end?{start:event.barTime,end}:null;
}

export type ForecastMinuteResult =
  | {status:'incomplete'|'unavailable'}
  | {
    status:'stop-first'|'target-first'|'same-minute'|'stop-only'|'target-only'|'neither';
    stopAt:number|null;targetAt:number|null;target:1|2;conditionConfirmed:boolean;
  };

/** Verify price touches in the disputed candle, independently of journal outcomes. */
export function checkForecastMinuteOrder(record:ForecastRecord,data:MarketData):ForecastMinuteResult {
  const window=forecastMinuteWindow(record);
  if(!window||data.instrument.market!=='crypto'||data.instrument.symbol!==record.symbol
    ||data.source!==record.source||data.instrument.exchange!==record.source.split(' 公共现货行情 · ')[0]
    ||data.adjustment!==record.adjustment||data.interval!=='1m')return {status:'unavailable'};
  const {start,end}=window;
  if(data.candles.length!==(end-start)/60||data.candles.some((bar,index)=>bar.time!==start+index*60||bar.closed!==true))
    return {status:'incomplete'};

  const previously=(type:'condition-met'|'target1')=>record.events.some(event=>event.type===type&&event.barTime<start&&event.at<=start);
  const conditionConfirmed=previously('condition-met');
  const target=conditionConfirmed&&previously('target1')?2:1;
  const buy=record.outlook.side==='long';
  const stopPrice=record.outlook.invalidationPrice,targetPrice=record.outlook.targets[target-1].price;
  let stopAt:number|null=null,targetAt:number|null=null;
  for(const bar of data.candles){
    if(bar.volume===0)continue; // A venue can carry forward the last price without trades.
    if(stopAt===null&&(buy?bar.low<=stopPrice:bar.high>=stopPrice))stopAt=bar.time;
    if(targetAt===null&&(buy?bar.high>=targetPrice:bar.low<=targetPrice))targetAt=bar.time;
    if(stopAt!==null&&targetAt!==null)break;
  }
  const status=stopAt===null?(targetAt===null?'neither':'target-only'):targetAt===null?'stop-only':
    stopAt===targetAt?'same-minute':stopAt<targetAt?'stop-first':'target-first';
  return {status,stopAt,targetAt,target,conditionConfirmed};
}

export async function loadForecastMinuteOrder(
  record:ForecastRecord,signal:AbortSignal,fetcher:typeof fetch=fetch,
):Promise<ForecastMinuteResult> {
  const window=forecastMinuteWindow(record);
  if(!window)return {status:'unavailable'};
  const query=new URLSearchParams({symbol:record.symbol,source:record.source,start:String(window.start),end:String(window.end)});
  const response=await fetcher(`/api/forecast-minute-window?${query}`,{signal});
  if(response.status===404)return {status:'unavailable'};
  const data=await readMarketResponse(response,{market:'crypto',symbol:record.symbol,interval:'1m'});
  return checkForecastMinuteOrder(record,data);
}
