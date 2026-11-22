import type {Analysis,Candle,Instrument,MarketData} from './market-types';
import type {StrokeCenter} from './center-layers';
import {candleAvailableAt} from './timeframe-context.ts';

export interface CenterBreakout {
  layer: 'segment' | 'stroke';
  direction: 'up' | 'down';
  boundary: number;
  close: number;
  confirmedAt: number;
  exchange: string;
  takerBuyShare: number | null;
}

export function supportsCenterBreakout(instrument:Pick<Instrument,'market'|'symbol'>):boolean {
  return instrument.market==='crypto'&&(instrument.symbol==='BTCUSDT'||instrument.symbol==='ETHUSDT');
}

/** Report the most recent close from inside the latest known center to outside.
 * Use only contiguous closed bars and a boundary that was known before the breakout. */
export function findCenterBreakout(
  data:Pick<MarketData,'instrument'|'interval'>,
  candles:readonly Candle[],
  analysis:Pick<Analysis,'centers'|'segments'>,
  strokeCenter?:StrokeCenter,
):CenterBreakout|null {
  if(!supportsCenterBreakout(data.instrument))return null;
  const segmentCenter=analysis.centers.at(-1);
  const center=segmentCenter??strokeCenter;
  if(!center)return null;

  let formedAt=strokeCenter?.formedAt;
  if(segmentCenter){
    const start=analysis.segments.findIndex(s=>s.confirmed&&s.from.index===segmentCenter.startIndex);
    const initial=analysis.segments.slice(start,start+3);
    if(start<0||initial.length!==3||initial.some(s=>!s.confirmed)||initial[2].to.index>segmentCenter.endIndex)return null;
    formedAt=Math.max(...initial.map(s=>s.confirmedAt));
  }
  if(formedAt===undefined||candles[formedAt]?.closed!==true)return null;

  for(let i=candles.length-1;i>formedAt;i--){
    const bar=candles[i],previous=candles[i-1];
    if(bar.closed!==true||previous.closed!==true||candleAvailableAt(previous,'crypto',data.interval)!==bar.time)continue;
    if(previous.close<center.low||previous.close>center.high)continue;
    const direction=bar.close>center.high?'up':bar.close<center.low?'down':null;
    if(!direction)continue;
    const share=bar.takerBuyShare;
    return {
      layer:segmentCenter?'segment':'stroke',direction,boundary:direction==='up'?center.high:center.low,
      close:bar.close,confirmedAt:candleAvailableAt(bar,'crypto',data.interval),exchange:data.instrument.exchange,
      takerBuyShare:data.instrument.exchange==='Binance'&&typeof share==='number'&&share>=0&&share<=1?share:null,
    };
  }
  return null;
}
