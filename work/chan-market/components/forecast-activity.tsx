"use client";
import {useMemo,useState} from 'react';
import {useLanguage} from '@/lib/language';
import {forecastIdentity,forecastStats,type ForecastJournal,type ForecastRecord} from '@/lib/forecast-journal';
import {forecastCohort} from '@/lib/forecast-audit';
import type {ForecastNotice} from '@/hooks/use-forecast-journal';
import type {MarketData} from '@/lib/market-types';
import {priceText} from './terminal-chart';
import {marketDisplayText} from '@/lib/market-i18n';
import {forecastMinuteWindow} from '@/lib/forecast-minute-order';
import ForecastSequenceCheck from './forecast-sequence-check';

const statusNames:Record<string,[string,string]>={watching:['观察中','Observing'],'condition-met':['条件曾满足','Condition met'],target1:['第一止盈价触及','Take-profit 1 price touched'],target2:['第二止盈价触及','Take-profit 2 price touched'],invalidated:['止损价触及','Stop-loss price touched'],invalidation:['止损价触及','Stop-loss price touched'],expired:['观察到期','Observation expired'],missed:['越过入场区间','Entry zone missed'],ambiguous:['先后不明','Ambiguous sequence'],'data-gap':['数据断档','Data gap']};
export default function ForecastActivity({journal,data,notices,saved}:{journal:ForecastJournal;data:MarketData|null;notices:ForecastNotice[];saved:boolean}) {
  const {t,locale,language}=useLanguage();const [all,setAll]=useState(false),[fee,setFee]=useState(5),[slippage,setSlippage]=useState(3),[chosenCohort,setChosenCohort]=useState<string|null>(null);
  const key=data?forecastIdentity(data):null;
  const scopedRecords=useMemo(()=>all?journal.records:journal.records.filter(r=>r.key===key),[journal,all,key]);
  const cohorts=useMemo(()=>[...new Set([...scopedRecords].reverse().map(forecastCohort))],[scopedRecords]);
  const cohort=chosenCohort&&cohorts.includes(chosenCohort)?chosenCohort:cohorts[0]??'';
  const records=useMemo(()=>scopedRecords.filter(r=>forecastCohort(r)===cohort),[scopedRecords,cohort]);
  const stats=useMemo(()=>forecastStats(records,fee,slippage),[records,fee,slippage]);
  const time=(s:number)=>new Date(s*1000).toLocaleString(locale,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  const name=(s:string)=>t(...(statusNames[s]??[s,s]));
  const exportRecords=()=>{const body=JSON.stringify({exportedAt:new Date().toISOString(),kind:'forecast-price-observations',cohort,feeBps:fee,slippageBps:slippage,records},null,2),url=URL.createObjectURL(new Blob([body],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='forecast-observations.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const recordDetails=(r:ForecastRecord)=><details className="forecast-record" key={r.id}><summary><span>{r.symbol} · {r.interval} · {r.outlook.side==='long'?t('多头预判','Long outlook'):t('空头预判','Short outlook')}</span><span>{time(r.createdAt)} · {name(r.status)}</span></summary><div><p>{t('发布时参考价','Reference at publication')} {priceText(r.referencePrice)} · {t('入场区间','Entry zone')} {priceText(r.outlook.zoneLow)}–{priceText(r.outlook.zoneHigh)}</p><p>{t('止损价','Stop-loss price')} {priceText(r.outlook.invalidationPrice)} · {t('第一止盈价','Take-profit 1 price')} {priceText(r.outlook.targets[0].price)} · {t('第二止盈价','Take-profit 2 price')} {priceText(r.outlook.targets[1].price)}</p><small>{marketDisplayText(r.source,language)} · {marketDisplayText(r.adjustment,language)}</small><ol><li>{time(r.createdAt)} · {t('预判已记录，后续更新不修改此处点位','Forecast recorded; later updates never rewrite these levels')}</li>{r.events.map(e=><li key={e.id}>{time(e.at)} · {name(e.type)} · {priceText(e.price)}</li>)}</ol>{forecastMinuteWindow(r)&&<ForecastSequenceCheck record={r}/>}</div></details>;
  return <section className="forecast-activity panel" aria-label={t('预判记录与提醒','Forecast records and alerts')}>
    <div className="card-top"><strong>{t('预判记录与提醒','Forecast records and alerts')}</strong><span>{saved?t('本机保存','Saved locally'):t('尚未保存','Not saved')}</span></div>
    {!saved&&<p className="activity-warning">{t('本机存储空间不足，当前记录暂未保存；可先导出。','Local storage is unavailable. Export the current records to keep them.')}</p>}
    <div className="activity-notices" aria-live="polite" aria-atomic="false">{notices.slice(0,5).map(n=><p key={n.id} className={n.type==='invalidation'||n.type==='invalidated'?'risk-notice':''}><b>{n.symbol} · {n.interval}</b> {n.intrabar?t('收到的报价触线','Received quote touched a level'):name(n.type)} · {n.intrabar?name(n.type):n.side==='long'?t('多头预判','Long outlook'):t('空头预判','Short outlook')} {priceText(n.price)} <small>{time(n.at)}</small></p>)}</div>
    <details className="journal-details"><summary>{t('查看完整记录与结果统计','View records and outcome statistics')} <span>{journal.records.length}</span></summary>
      <div className="journal-controls"><label><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>{t('全部已监测标的与周期','All monitored symbols and periods')}</label><button onClick={exportRecords} disabled={!records.length}>{t('导出记录','Export records')}</button></div>
      {cohorts.length>0&&<div className="journal-controls"><label>{t('预判版本','Forecast version')}<select aria-label={t('预判版本','Forecast version')} value={cohort} onChange={e=>setChosenCohort(e.target.value)}>{cohorts.map(c=><option key={c} value={c}>{c==='legacy-unversioned'?t('旧版未记录版本','Legacy · version not recorded'):c}</option>)}</select></label><span className="micro-copy">{t('各版本分别统计；导出包含发布时的指标与数据摘要。','Versions are counted separately; export includes the original indicators and input summary.')}</span></div>}
      <p className="micro-copy">{t('从本次使用起记录。历史点位保留，结果是价格事件，不代表下单或持仓。','Records start when observed in this version. Original levels are retained; outcomes are price events, not orders or positions.')}</p>
      <div className="journal-metrics"><span>{t('预判次数','Forecasts')} <b>{stats.published}</b></span><span>{t('条件满足','Conditions met')} <b>{stats.confirmed}</b></span><span>{t('第二止盈价触及','Take-profit 2 price touched')} <b>{stats.targets}</b></span><span>{t('条件满足后触及止损价','Stop-loss price touched after condition')} <b>{stats.invalidated}</b></span><span>{t('先后不明','Ambiguous')} <b>{stats.ambiguous}</b></span></div>
      <details className="cost-study"><summary>{t('查看假设成本后的价格结果','View price outcomes under cost assumptions')}</summary><div className="journal-controls"><label>{t('单边手续费（基点）','Fee per side (bps)')}<input type="number" min="0" max="1000" value={fee} onChange={e=>setFee(Math.min(1000,Math.max(0,Number(e.target.value)||0)))}/></label><label>{t('单边滑点（基点）','Slippage per side (bps)')}<input type="number" min="0" max="1000" value={slippage} onChange={e=>setSlippage(Math.min(1000,Math.max(0,Number(e.target.value)||0)))}/></label></div><p>{t('有效结束样本','Resolved observations')} {stats.resolved} · {t('平均净价格变动','Mean net price change')} {stats.netMeanPct===null?'—':`${stats.netMeanPct.toFixed(2)}%`} · {t('正收益观察占比','Positive observations')} {stats.resolved<20?t('样本不足20，暂不显示','Hidden: fewer than 20 observations'):`${stats.positivePct?.toFixed(1)}%`}</p><p className="micro-copy">{t('按入场区间不利端与止盈价、止损价估算，双边计费与滑点；先后不明不计收益。观察可能重叠，未模拟实际成交、资金曲线、借券、涨跌停与交易限制。不是账户回报或未来胜率。','Estimated from the adverse edge of the entry zone and the take-profit or stop-loss price, with fees and slippage on both sides. Ambiguous sequences are excluded. Observations may overlap; fills, capital, borrowing and trading restrictions are not simulated. This is neither account performance nor a future win probability.')}</p></details>
      {!records.length&&<p className="empty-mini">{t('暂无记录。行情有效、方向明确时自动保存当前预判。','No records yet. A clear outlook is saved automatically when the feed is available.')}</p>}
      {[...records].reverse().slice(0,80).map(recordDetails)}
      {records.length>80&&<p className="micro-copy">{t('页面显示最近80条，导出包含当前筛选全部记录。','Showing the latest 80; export contains all filtered records.')}</p>}
      {journal.trimmed>0&&<p className="micro-copy">{t(`本机保留最近600条，已滚动移除${journal.trimmed}条；统计仅覆盖保留记录。`,`The latest 600 records are retained; ${journal.trimmed} older records have rolled off. Statistics cover retained records only.`)}</p>}
    </details>
  </section>;
}
