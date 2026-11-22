'use client';
import {useEffect,useRef,useState} from 'react';
import {useLanguage} from '@/lib/language';
import type {ForecastRecord} from '@/lib/forecast-journal';
import {loadForecastMinuteOrder,type ForecastMinuteResult} from '@/lib/forecast-minute-order';

export default function ForecastSequenceCheck({record}:{record:ForecastRecord}) {
  const {t,locale}=useLanguage();
  const pending=useRef<AbortController|null>(null);
  const [checking,setChecking]=useState(false);
  const [result,setResult]=useState<ForecastMinuteResult|null>(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>()=>pending.current?.abort(),[]);

  async function check(){
    if(pending.current)return;
    const request=new AbortController();
    pending.current=request;
    setChecking(true);setFailed(false);setResult(null);
    try{
      const next=await loadForecastMinuteOrder(record,AbortSignal.any([request.signal,AbortSignal.timeout(28000)]));
      if(!request.signal.aborted)setResult(next);
    }catch{
      if(!request.signal.aborted)setFailed(true);
    }finally{
      pending.current=null;
      if(!request.signal.aborted)setChecking(false);
    }
  }

  function outcome(value:Extract<ForecastMinuteResult,{stopAt:number|null}>){
    const target=value.target===1?t('第一止盈','Take-profit 1'):t('第二止盈','Take-profit 2');
    const time=(at:number|null)=>at===null?t('未触及','Not touched'):new Date(at*1000).toLocaleString(locale,{
      month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZoneName:'short',
    });
    const summary={
      'stop-first':t('先触及止损','Stop-loss touched first'),
      'target-first':t(`先触及${target}`,`${target} touched first`),
      'same-minute':t('同一分钟内触及，先后仍不明','Both touched in the same minute; order is still unclear'),
      'stop-only':t('仅触及止损','Only stop-loss was touched'),
      'target-only':t(`仅触及${target}`,`Only ${target} was touched`),
      'neither':t('这两处价位均未触及','Neither level was touched'),
    };
    return <>
      <p><strong>{summary[value.status]}</strong></p>
      <p>{t('止损分钟','Stop-loss minute')} {time(value.stopAt)} · {t(`${target}分钟`,`${target} minute`)} {time(value.targetAt)}</p>
      {!value.conditionConfirmed&&<small>{t('当时入场条件尚未单独确认。以上仅核对价位触及时序。','The entry condition had not been independently confirmed. This only checks the order of price touches.')}</small>}
      {value.target===2&&<small>{t('第一止盈此前已触及，本次核对第二止盈。','Take-profit 1 was previously touched. This check uses take-profit 2.')}</small>}
    </>;
  }

  return <div className="forecast-minute-check">
    <div className="journal-controls">
      <button type="button" onClick={()=>void check()} disabled={checking}>
        {checking?t('正在读取同源分钟数据…','Loading same-source minutes…'):t('用 1 分钟 K 线核对先后','Check order with 1-minute candles')}
      </button>
    </div>
    <div role="status">
      {failed&&<p>{t('同源分钟查询失败，可稍后重试。','Same-source minute request failed. You can retry.')}</p>}
      {result&&('stopAt' in result?outcome(result):<p>{result.status==='incomplete'
        ?t('同源分钟数据未完整覆盖该 K 线，先后仍不明。','Same-source minutes do not cover the full candle. Order is still unclear.')
        :t('没有可用的同源分钟数据，先后仍不明。','Same-source minutes are unavailable. Order is still unclear.')}</p>)}
    </div>
  </div>;
}
