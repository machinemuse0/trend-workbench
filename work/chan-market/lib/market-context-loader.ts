import type {Interval,Market,MarketData} from './market-types';
import {readMarketResponse} from './market-response.ts';
import {higherInterval} from './timeframe-context.ts';
import {compatibleMarketFeeds,deriveHigherFromPrimary} from './higher-from-primary.ts';

export type HigherFeed = {interval:Interval|null;status:'ready'|'loading'|'error'|'none'|'imported';data?:MarketData};
export interface ChartSnapshot {data:MarketData; higher:HigherFeed; receivedAt:number}
type Fetcher=(input:string,init:{signal:AbortSignal})=>Promise<Response>;
export type MarketContextRequest = {
  market:Market;symbol:string;interval:Interval;signal:AbortSignal;
  onPrimary:(data:MarketData)=>void;onPrimaryError:(message:string)=>void;
  onHigher:(feed:HigherFeed)=>void;fetcher?:Fetcher;
};

/** Each feed settles independently: a slow or missing parent must not blank the main chart.
 * An abort suppresses ALL callbacks, even with a transport that ignores AbortSignal.
 */
export async function loadMarketContext(request:MarketContextRequest):Promise<void> {
  const {market,symbol,interval,signal,onPrimary,onPrimaryError,onHigher}=request;
  if(signal.aborted)return;
  const fetcher=request.fetcher??((url,init)=>fetch(url,{signal:AbortSignal.any([init.signal,AbortSignal.timeout(90000)])}));
  const higher=higherInterval(market,interval);
  const load=async(period:Interval):Promise<MarketData>=>{
    const response=await fetcher(`/api/candles?market=${market}&symbol=${encodeURIComponent(symbol)}&interval=${period}`,{signal});
    return readMarketResponse(response,{market,symbol,interval:period});
  };
  onHigher({interval:higher,status:higher?'loading':'none'});
  let primary:MarketData|undefined,parent:MarketData|undefined;
  await Promise.allSettled([
    load(interval).then(data=>{primary=data;if(!signal.aborted)onPrimary(data);},error=>{if(!signal.aborted)onPrimaryError(error instanceof Error?error.message:'加载失败，请重试');}),
    higher?load(higher).then(data=>{parent=data;}):Promise.resolve(),
  ]);
  if(signal.aborted||!higher)return;
  if(primary&&parent&&compatibleMarketFeeds(primary,parent)) {
    onHigher({interval:higher,status:'ready',data:parent});return;
  }
  const derived=primary?deriveHigherFromPrimary(primary):null;
  if(signal.aborted)return;
  onHigher(derived?{interval:higher,status:'ready',data:derived}:{interval:higher,status:'error'});
}

/** Publish a changed latest candle promptly. A preview carries loading context
 * so analysis never pairs new primary candles with a previous parent response. */
export function createChartFeedController(fetcher?:Fetcher) {
  let active:AbortController|null=null;
  let lastPrimary:MarketData|undefined;
  function cancel() {
    const previous=active;
    active=null;
    previous?.abort();
  }
  async function load(request:Pick<MarketContextRequest,'market'|'symbol'|'interval'|'onPrimaryError'> & {
    background:boolean; onSnapshot:(snapshot:ChartSnapshot)=>void;
  }) {
    if(request.background&&active)return;
    cancel();
    const controller=new AbortController();active=controller;
    const parentInterval=higherInterval(request.market,request.interval);
    let primary:MarketData|undefined;
    let receivedAt=0;
    try {
      await loadMarketContext({...request,fetcher,signal:controller.signal,
        onPrimary(data) {
          const previous=lastPrimary;
          const oldBar=previous?.candles.at(-1),newBar=data.candles.at(-1);
          const sameSeries=previous?.instrument.market===data.instrument.market
            &&previous.instrument.symbol===data.instrument.symbol&&previous.interval===data.interval
            &&previous.source===data.source&&previous.adjustment===data.adjustment;
          if(request.background&&sameSeries&&oldBar&&newBar) {
            const sameBar=newBar.time===oldBar.time;
            const reopened=sameBar&&oldBar.closed===true&&newBar.closed===false;
            const olderUpdate=sameBar&&newBar.closed===oldBar.closed&&Date.parse(data.asOf)<Date.parse(previous.asOf);
            if(newBar.time<oldBar.time||reopened||olderUpdate) {
              // Free the next poll even if the matching parent ignores cancellation.
              cancel();
              return;
            }
          }
          primary=lastPrimary=data;
          receivedAt=Date.now();
          const changed=!sameSeries||!oldBar||!newBar||newBar.time!==oldBar.time
            ||newBar.open!==oldBar.open||newBar.high!==oldBar.high||newBar.low!==oldBar.low
            ||newBar.close!==oldBar.close||newBar.volume!==oldBar.volume||newBar.closed!==oldBar.closed;
          if(!parentInterval||!request.background||changed)request.onSnapshot({data,receivedAt,higher:{interval:parentInterval,status:parentInterval?'loading':'none'}});
        },
        onHigher(higher) {
          if(primary)request.onSnapshot({data:primary,higher,receivedAt});
        },
      });
    } finally {
      if(active===controller)active=null;
    }
  }
  return {load,cancel};
}
