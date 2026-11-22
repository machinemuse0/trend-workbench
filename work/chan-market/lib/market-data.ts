import type { Candle, Instrument, Interval, Market, MarketData } from './market-types';
import { getCryptoCandles, getCryptoMinuteWindow, searchCrypto, CryptoDataError } from './crypto-sources.ts';
export { resetMarketNetworkFailures } from './crypto-sources.ts';
import { aggregateEquityFourHour } from './equity-four-hour.ts';
import { chooseEquityHistory } from './equity-history.ts';
import { withHistoryCoverage } from './history-coverage.ts';

/** Public market-data adapters. No credentials, no trading and no synthetic prices. */
export class MarketError extends Error {
  status: number;
  upstreamStatus?: number;
  constructor(message: string, status = 502, upstreamStatus?: number) { super(message); this.name = 'MarketError'; this.status = status; this.upstreamStatus = upstreamStatus; }
}
const ALL_INTERVALS: Interval[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'];
export const AVAILABLE_INTERVALS: Record<Market, Interval[]> = {
  crypto: ALL_INTERVALS,
  us: ALL_INTERVALS,
  cn: ALL_INTERVALS,
};
const MINUTES: Record<Exclude<Interval, '1M'>, number> = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 };
const isCalendarBar = (interval: Interval) => ['1d', '1w', '1M'].includes(interval);
const eastmoneyPeriod = (interval: Interval) => interval === '1M' ? '103' : interval === '1w' ? '102' : interval === '1d' ? '101' : String(MINUTES[interval]);
const US_EXCHANGES = new Set(['NMS','NGM','NCM','NYQ','ASE','PCX','BTS','BATS','PNK','OQB','OQX','OBB','CXI','DJI','SNP','WCB']);
interface YahooSearch {quotes?:{exchange:string;quoteType:string;symbol:string;shortname?:string;longname?:string;exchDisp?:string}[]}
interface YahooChart {chart?:{error?:unknown;result?:{meta?:{dataGranularity?:string;exchangeTimezoneName?:string;currentTradingPeriod?:{regular?:{end:number}};longName?:string;shortName?:string;fullExchangeName?:string;exchangeName?:string;currency?:string};timestamp?:number[];indicators?:{quote?:{open:(number|null)[];high:(number|null)[];low:(number|null)[];close:(number|null)[];volume:(number|null)[]}[];adjclose?:{adjclose:(number|null)[]}[]}}[]}}
interface EastmoneyData {data?:{code:string;market:number;name?:string;klines?:string[]}}
let yahooUnavailableUntil = 0;
let yahooSearchUnavailableUntil = 0;
let cnEastmoneyUnavailableUntil = 0;
const cache = new Map<string, { expires: number; value: Promise<unknown> }>();
async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
  if (cache.size > 160) { for (const [k,v] of cache) if (v.expires < Date.now()) cache.delete(k); if (cache.size > 160) cache.delete(cache.keys().next().value!); }
  const value = fn().catch(error => { cache.delete(key); throw error; });
  cache.set(key, { expires: Date.now() + ttl, value });
  return value;
}
async function upstream(url: string, encoding = 'utf-8'): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChanObservatory/1.0)', Accept: 'application/json,text/plain,*/*' } });
    if (!response.ok) throw new MarketError(response.status === 429 ? '行情源限流，请稍后重试。' : `行情源返回 HTTP ${response.status}。`, response.status === 404 ? 404 : 502, response.status);
    return new TextDecoder(encoding).decode(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof MarketError) throw error;
    throw new MarketError('行情源暂时无法连接或请求超时，请重试。');
  } finally { clearTimeout(timer); }
}
async function json<T>(url: string): Promise<T> {
  try { return JSON.parse(await upstream(url)) as T; }
  catch (error) { if (error instanceof MarketError) throw error; throw new MarketError('行情源返回格式异常，未使用替代价格。'); }
}
function instrument(market: Market, symbol: string, name: string, exchange: string, currency: string): Instrument {
  return { id: `${market}:${symbol}`, market, symbol, name, exchange, currency };
}
const popularRows: Record<Market, [string, string, string, string][]> = {
  crypto: [['BTCUSDT','比特币 Bitcoin','Binance','USDT'],['ETHUSDT','以太坊 Ethereum','Binance','USDT'],['SOLUSDT','Solana','Binance','USDT'],['BNBUSDT','BNB','Binance','USDT'],['XRPUSDT','XRP','Binance','USDT'],['DOGEUSDT','Dogecoin','Binance','USDT'],['ADAUSDT','Cardano','Binance','USDT'],['AVAXUSDT','Avalanche','Binance','USDT'],['LINKUSDT','Chainlink','Binance','USDT'],['SUIUSDT','Sui','Binance','USDT'],['LTCUSDT','Litecoin','Binance','USDT'],['DOTUSDT','Polkadot','Binance','USDT']],
  us: [['AAPL','苹果 Apple','NASDAQ','USD'],['MSFT','微软 Microsoft','NASDAQ','USD'],['NVDA','英伟达 NVIDIA','NASDAQ','USD'],['TSLA','特斯拉 Tesla','NASDAQ','USD'],['AMZN','亚马逊 Amazon','NASDAQ','USD'],['GOOGL','谷歌 Alphabet','NASDAQ','USD'],['META','Meta Platforms','NASDAQ','USD'],['AMD','AMD','NASDAQ','USD'],['COIN','Coinbase','NASDAQ','USD'],['MSTR','Strategy','NASDAQ','USD'],['SPY','标普500 ETF','NYSE Arca','USD'],['QQQ','纳斯达克100 ETF','NASDAQ','USD']],
  cn: [['600519.SH','贵州茅台 guizhoumaotai gzmt','上交所','CNY'],['300750.SZ','宁德时代 ningdeshidai ndsd','深交所','CNY'],['002594.SZ','比亚迪 biyadi byd','深交所','CNY'],['000001.SZ','平安银行 pinganyinhang payh','深交所','CNY'],['600036.SH','招商银行 zhaoshangyinhang zsyh','上交所','CNY'],['601318.SH','中国平安 zhongguopingan zgpa','上交所','CNY'],['600900.SH','长江电力 changjiangdianli cjdl','上交所','CNY'],['000858.SZ','五粮液 wuliangye wly','深交所','CNY'],['000333.SZ','美的集团 meidijituan mdjt','深交所','CNY'],['688981.SH','中芯国际 zhongxinguoji zxgj','上交所','CNY'],['300059.SZ','东方财富 dongfangcaifu dfcf','深交所','CNY'],['920599.BJ','同力股份 tongligufen tlgf','北交所','CNY']],
};
function popular(market: Market, q: string): Instrument[] {
  const key = q.toLowerCase().replace(/[\s/]/g, '');
  return popularRows[market].filter(row => !key || row.slice(0,2).join('').toLowerCase().replace(/\s/g, '').includes(key)).map(row => instrument(market, row[0], market === 'cn' ? row[1].split(' ')[0] : row[1], row[2], row[3]));
}
function unique(rows: Instrument[]): Instrument[] {
  const found = new Map<string, Instrument>();
  for (const row of rows) if (!found.has(row.id)) found.set(row.id, row);
  return [...found.values()].slice(0, 30);
}
export type SearchMarket = Market | 'all';
interface SearchResult { results: Instrument[]; warning?: string }
const SEARCH_MARKETS: Market[] = ['crypto', 'us', 'cn'];
const MARKET_NAMES: Record<Market, string> = { crypto: '加密货币', us: '美股', cn: 'A股' };
export function parseSearchMarket(value: string | null): SearchMarket {
  return !value || value === 'all' ? 'all' : parseMarket(value);
}
export function parseMarket(value: string | null): Market {
  if (value === 'crypto' || value === 'us' || value === 'cn') return value;
  throw new MarketError('请选择 crypto、us 或 cn 市场。', 400);
}
export function parseInterval(value: string | null, market: Market): Interval {
  if (!value || !ALL_INTERVALS.includes(value as Interval)) throw new MarketError('不支持的K线周期。', 400);
  if (!AVAILABLE_INTERVALS[market].includes(value as Interval)) throw new MarketError('该市场不提供所选K线周期。', 422);
  return value as Interval;
}
export function normalizeSymbol(market: Market, input: string): string {
  const value = input.trim().toUpperCase();
  if (market === 'crypto') {
    const symbol = value.replace(/\//g, '');
    if (!/^[A-Z0-9]{4,30}$/.test(symbol)) throw new MarketError('请输入有效的现货交易对，例如 BTCUSDT。', 400);
    return symbol;
  }
  if (market === 'us') {
    if (!/^[A-Z^][A-Z0-9.^-]{0,19}$/.test(value) || /\.(SS|SZ|HK|L|TO|AX|DE|PA|T)$/.test(value)) throw new MarketError('请输入美股代码，例如 AAPL、BRK-B。', 400);
    return value.replace(/\./g, '-');
  }
  const match = value.match(/^(?:(SH|SZ|BJ))?(\d{6})(?:\.(SH|SZ|BJ|SS))?$/);
  if (!match || (match[1] && match[3] && match[1] !== match[3])) throw new MarketError('请输入六位A股代码，或 600519.SH、000001.SZ、920599.BJ。', 400);
  const code = match[2];
  const exchange = (match[1] || match[3] || (/^(4|8|92)/.test(code) ? 'BJ' : /^[569]/.test(code) ? 'SH' : 'SZ')).replace('SS', 'SH');
  if (exchange === 'BJ' && !/^(4|8|92)/.test(code) || exchange !== 'BJ' && /^(4|8|92)/.test(code) || exchange === 'SZ' && /^[569]/.test(code) || exchange === 'SH' && /^[123]/.test(code)) throw new MarketError('代码与沪、深、北交易所后缀不匹配。',400);
  return `${code}.${exchange}`;
}
export function sanitizeCandles(rows: Candle[]): Candle[] {
  const valid = rows.filter(c => [c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) && c.time > 0 && c.low > 0 && c.volume >= 0 && c.high >= c.low && c.high >= Math.max(c.open,c.close) - 1e-7 && c.low <= Math.min(c.open,c.close) + 1e-7);
  return [...new Map(valid.map(c => [c.time,c])).values()].sort((a,b) => a.time-b.time);
}
export function localClock(time: number, zone: string): { date: string; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(time * 1000));
  const p = Object.fromEntries(parts.map(x => [x.type,x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), weekday: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday) };
}
/** Convert a US exchange-local date without assuming a fixed UTC offset. */
function usDateStamp(date: string): number {
  const guess = Date.parse(`${date}T14:30:00Z`)/1000;
  if (!Number.isFinite(guess)) return NaN;
  const clock = localClock(guess,'America/New_York');
  return guess + (570-clock.hour*60-clock.minute)*60;
}
async function tencentHints(q: string, market: 'gp'|'us'): Promise<string[][]> {
  const text = await upstream(`https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(q)}&t=${market}`,'gbk');
  const body = text.match(/v_hint\s*=\s*"([\s\S]*?)"/)?.[1];
  if (body === undefined) throw new MarketError('在线标的搜索暂不可用。');
  return body.replace(/\\u([0-9a-fA-F]{4})/g, (_,h) => String.fromCharCode(parseInt(h,16))).split('^').map(s=>s.split('~'));
}
function usHint(row: string[]): { symbol: string; name: string; exchange: string; secid: string } | undefined {
  if (row[0] !== 'us') return;
  const match = row[1]?.toUpperCase().match(/^([A-Z][A-Z0-9.\-]*)\.(OQ|N|AM)$/);
  if (!match) return;
  const markets: Record<string,[string,string]> = {OQ:['105','NASDAQ'],N:['106','NYSE'],AM:['107','NYSE Arca / AMEX']};
  const [id,exchange] = markets[match[2]];
  return { symbol:match[1].replace(/\./g,'-'), name:row[2], exchange, secid:`${id}.${match[1].replace(/\./g,'_')}` };
}
async function usHints(q: string) {
  return cached(`tencent-us:${q.toUpperCase()}`, 30*60000, async () => (await tencentHints(q.replace(/-/g,'.'),'us')).map(usHint).filter((x): x is NonNullable<typeof x> => !!x));
}
/** Calendar bars close conservatively. Monthly bars are confirmed only after local month-end. */
export function stockBarClosed(time: number, interval: Interval, market: 'cn' | 'us', now = Date.now() / 1000, sessionEnd?: number): boolean {
  if (!Number.isFinite(time) || !Number.isFinite(now)) return false;
  const zone = market === 'cn' ? 'Asia/Shanghai' : 'America/New_York';
  const bar = localClock(time, zone), current = localClock(now, zone);
  const safetySeconds = market === 'us' ? 900 : 120;
  if (interval === '1M') return bar.date.slice(0, 7) < current.date.slice(0, 7);
  if (interval === '1d') {
    if (bar.date < current.date) return true;
    const endMinute = market === 'cn' ? 15 * 60 + 2 : 16 * 60 + 15;
    return bar.date === current.date && current.hour * 60 + current.minute >= endMinute;
  }
  if (interval === '1w') {
    const start = new Date(`${bar.date}T00:00:00Z`);
    const daysToFriday = (5 - bar.weekday + 7) % 7;
    start.setUTCDate(start.getUTCDate() + daysToFriday);
    const friday = start.toISOString().slice(0,10);
    if (current.date > friday) return true;
    return current.date === friday && current.hour * 60 + current.minute >= (market === 'cn' ? 902 : 975);
  }
  // Eastmoney labels minute bars by END time; Yahoo labels them by START time.
  if (market === 'cn') return now >= time + safetySeconds;
  if (bar.date < current.date) return true;
  let end = time + MINUTES[interval] * 60;
  if (sessionEnd && sessionEnd > time) end = Math.min(end, sessionEnd);
  else {
    const minutesToRegularEnd = 16 * 60 - bar.hour * 60 - bar.minute;
    if (minutesToRegularEnd > 0) end = Math.min(end, time + minutesToRegularEnd * 60);
  }
  return now >= end + safetySeconds;
}

function searchRank(row: Instrument, query: string): number {
  const key = query.toLowerCase().replace(/[\s/]/g, '');
  const symbol = row.symbol.toLowerCase(), name = row.name.toLowerCase();
  if (row.name.startsWith('代码查询 ')) return -1;
  if (symbol === key || row.market === 'cn' && symbol.split('.')[0] === key) return 100;
  if (row.market === 'cn') {
    try { if (normalizeSymbol('cn', query) === row.symbol) return 100; } catch { /* A name or pinyin query. */ }
  }
  if (name.replace(/\s/g, '') === key || name.split(/\s+/).includes(key)) return 90;
  if (row.market === 'crypto' && symbol === key + row.currency.toLowerCase()) return 85;
  if (symbol.startsWith(key) || name.startsWith(key)) return 70;
  if (symbol.includes(key) || name.includes(key)) return 50;
  return 10; // A provider can match Chinese names and pinyin that are not in the display name.
}
function rankSearch(rows: Instrument[], query: string): Instrument[] {
  return unique([...rows].sort((a,b) => searchRank(b,query) - searchRank(a,query)));
}
/** Search markets independently: a slow exchange directory must not hide a matching stock. */
async function boundedMarketSearch(market: Market, query: string): Promise<SearchResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      searchSingleMarket(market, query),
      new Promise<SearchResult>(resolve => {
        timer = setTimeout(() => resolve({ results: popular(market, query), warning: '搜索响应较慢，已显示当前可用结果；可选择该市场重试。' }), 5000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
export async function searchInstruments(market: SearchMarket, query: string): Promise<SearchResult> {
  const q = query.trim().slice(0,60);
  if (market !== 'all') {
    const result = await searchSingleMarket(market,q);
    return { ...result, results: rankSearch(result.results,q) };
  }
  if (!q) return { results: unique(SEARCH_MARKETS.flatMap(m => popular(m,''))), warning: '跨市场搜索：输入股票名称、拼音、代码或加密货币名称。' };
  const replies = await Promise.allSettled(SEARCH_MARKETS.map(m => boundedMarketSearch(m,q)));
  const rows: Instrument[] = [], warnings: string[] = [];
  replies.forEach((reply,index) => {
    if (reply.status === 'fulfilled') {
      rows.push(...reply.value.results);
      if (reply.value.warning) warnings.push(`${MARKET_NAMES[SEARCH_MARKETS[index]]}：${reply.value.warning}`);
    } else warnings.push(`${MARKET_NAMES[SEARCH_MARKETS[index]]}搜索暂不可用。`);
  });
  // Direct-code fallbacks are useful when everything fails, but must not crowd out verified matches.
  const verified = rows.filter(row => !row.name.startsWith('代码查询 '));
  const results = rankSearch(verified.length ? verified : rows,q);
  return { results, ...(warnings.length ? {warning: warnings.join('；')} : {}) };
}
async function searchSingleMarket(market: Market, query: string): Promise<SearchResult> {
  const q = query.trim().slice(0,60);
  if (!q) return { results: popular(market, ''), warning: '常用标的；输入代码或名称搜索更多。' };
  const local = popular(market,q);
  try {
    return await cached(`search:${market}:${q.toLowerCase()}`, 5 * 60000, async () => {
      if (market === 'crypto') {
        return {results:await searchCrypto(q)};
      }
      if (market === 'us') {
        const key = local[0]?.symbol && /[^\x00-\x7F]/.test(q) ? local[0].symbol : q;
        try {
          if (yahooSearchUnavailableUntil>Date.now()) throw new MarketError('Yahoo搜索暂不可用。');
          const data = await json<YahooSearch>(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(key)}&quotesCount=20&newsCount=0&enableFuzzyQuery=false`);
          if (!Array.isArray(data.quotes)) throw new MarketError('美股搜索暂不可用。');
          const rows = data.quotes.filter(x => US_EXCHANGES.has(x.exchange) && ['EQUITY','ETF','INDEX'].includes(x.quoteType)).map(x => instrument('us',normalizeSymbol('us',x.symbol),x.shortname || x.longname || x.symbol,x.exchDisp || x.exchange,'USD'));
          return { results: unique([...rows,...local]) };
        } catch {
          if (yahooSearchUnavailableUntil<=Date.now()) yahooSearchUnavailableUntil=Date.now()+5*60000;
          const rows = (await usHints(key)).map(x=>instrument('us',x.symbol,x.name,x.exchange,'USD'));
          return {results:unique([...rows,...local]),warning:'Yahoo搜索暂不可用，已切换腾讯美股搜索；支持范围取决于备用源收录。'};
        }
      }
      const directCode = /^(?:(SH|SZ|BJ))?\d{6}(?:\.(SH|SZ|BJ|SS))?$/i.test(q) ? normalizeSymbol('cn',q) : undefined;
      const rows = (await tencentHints(directCode ? directCode.slice(0,6) : q,'gp')).filter(x=>['sh','sz','bj'].includes(x[0]) && /^\d{6}$/.test(x[1])).map(x=>instrument('cn',`${x[1]}.${x[0].toUpperCase()}`,x[2], x[0]==='sh'?'上交所':x[0]==='bj'?'北交所':'深交所','CNY'));
      // Search by an exact code is still useful when the hint service does not index a new listing.
      if (directCode) {
        const symbol = directCode;
        if (!rows.some(r=>r.symbol===symbol)) rows.push(instrument('cn',symbol,`代码查询 ${symbol.slice(0,6)}`,symbol.endsWith('SH')?'上交所':symbol.endsWith('BJ')?'北交所':'深交所','CNY'));
      }
      return { results: unique([...rows,...local]) };
    });
  } catch {
    const results = [...local];
    try {
      if (market === 'cn' && /\d{6}/.test(q)) { const symbol = normalizeSymbol(market,q); results.push(instrument(market,symbol,`代码查询 ${symbol}`,symbol.endsWith('SH')?'上交所':symbol.endsWith('BJ')?'北交所':'深交所','CNY')); }
      if (market === 'us' && /^[A-Za-z^][A-Za-z0-9.^-]{0,19}$/.test(q)) { const symbol = normalizeSymbol(market,q); results.push(instrument(market,symbol,`代码查询 ${symbol}`,'待行情源确认','USD')); }
    } catch { /* Invalid direct symbol is not exposed. */ }
    return { results: unique(results), warning: '在线搜索暂时不可用；仅显示匹配的常用标的或待行情核验的代码。' };
  }
}

export async function getCandles(market: Market, rawSymbol: string, interval: Interval, requestedLimit = 800): Promise<MarketData> {
  const symbol = normalizeSymbol(market,rawSymbol);
  parseInterval(interval,market);
  const limit = Math.min(1000,Math.max(100,Number.isFinite(requestedLimit)?Math.floor(requestedLimit):800));
  return cached(`candles:${market}:${symbol}:${interval}:${limit}`, 30000, async () => {
    const data = market === 'crypto' ? await cryptoCandles(symbol,interval,limit)
      : interval === '4h' ? await equityFourHourCandles(market,symbol,limit)
      : market === 'us' ? await usCandles(symbol,interval,limit)
      : await cnCandles(symbol,interval,limit);
    return withHistoryCoverage(data,limit);
  });
}
async function equityFourHourCandles(market: 'cn' | 'us', symbol: string, limit: number): Promise<MarketData> {
  // Fetch extra children before aggregation; the public result still respects
  // the requested limit. Every candidate is an independent, unmixed source.
  const sourceLimit = Math.min(8200, limit * (market === 'cn' ? 4 : 7) + 16);
  const candidates: (() => Promise<MarketData>)[] = market === 'cn'
    // The same 1,023-bar source window covers twice as many sessions at 60m.
    // Keep fallbacks independent so a short Eastmoney response cannot hide a
    // deeper Tencent response. All candidates remain genuine session OHLC.
    ? [() => cnSinaCandles(symbol,'1h',sourceLimit), () => cnEastmoneyCandles(symbol,'1h',sourceLimit), () => cnTencentCandles(symbol,'1h',sourceLimit)]
    : [
      ...(yahooUnavailableUntil > Date.now() ? [] : [async () => {
        try { return await yahooCandles(symbol,'1h',sourceLimit); }
        catch (error) {
          if (error instanceof MarketError && [403,429].includes(error.upstreamStatus || 0)) yahooUnavailableUntil = Date.now() + 5*60000;
          throw error;
        }
      }]),
      () => usEastmoneyCandles(symbol,'30m',sourceLimit),
    ];
  let lastError: unknown;
  const aggregate = async (candidate: () => Promise<MarketData>): Promise<MarketData | undefined> => {
    try {
      const data = await candidate();
      const result = aggregateEquityFourHour(data.candles, { market, sourceInterval: data.interval as '30m'|'1h', timestamp: data.source.startsWith('Yahoo') ? 'start' : 'end' });
      const candles = ensure(result.candles,1).slice(-limit);
      const childPeriod = data.interval === '1h' ? '1小时' : '30分钟';
      const rule = market === 'cn'
        ? 'A股4小时按09:30–11:30、13:00–15:00累计4个交易小时，每个交易日一根，午休不计入。'
        : '美股4小时按纽约正常交易时段聚合：09:30–13:30为4小时，13:30–16:00尾段为2.5小时，分别保留；不跨交易日，自动处理夏令时。';
      const warnings = data.warnings.filter(w => !/本次仅返回|仅有\d+根|备用源返回\d+根|东方财富连接失败|分钟K线保留源|免费分钟K线历史窗口有限/.test(w));
      warnings.push(rule, '聚合K线标记周期起点；仅使用同一来源真实子K线，全部子K收盘且覆盖完整后才确认，未完成尾部不参与收盘信号。');
      if (market === 'us') warnings.push('提前收市或子K缺失导致覆盖不足的历史区间会跳过；不会补价或跨日拼成4小时。');
      if (result.discardedBuckets) warnings.push(`已跳过${result.discardedBuckets}个覆盖不完整的历史区间或缺口区间。`);
      if (candles.length < 200) warnings.push(`4小时有效K线仅${candles.length}根，受来源分钟历史窗口限制，统计样本可能不足。`);
      return { ...data, interval: '4h', candles, source: `${data.source} · ${childPeriod}聚合4小时`, delayNotice: `${data.delayNotice.split(' · ')[0]} · ${market === 'cn' ? 'Asia/Shanghai' : 'America/New_York'} · 聚合K线为周期起点`, warnings, availableIntervals: AVAILABLE_INTERVALS[market] };
    } catch (error) { lastError = error; return undefined; }
  };
  // A non-empty response is not necessarily enough history. Compare available
  // complete feeds; freshness wins over depth and sources are never spliced.
  const alternatives = await Promise.all(candidates.map(aggregate));
  const best = chooseEquityHistory(alternatives.filter((data): data is MarketData => !!data));
  if (best) return best;
  if (lastError instanceof MarketError) throw lastError;
  throw new MarketError('4小时所需的真实子K线暂不可用，请稍后重试。');
}
function ensure(rows: Candle[], minimum = 10): Candle[] {
  const data = sanitizeCandles(rows);
  if (!data.length) throw new MarketError('未找到有效OHLC行情，请核对标的或更换周期。',404);
  if (data.length < minimum) throw new MarketError(`历史K线不足${minimum}根，暂不能进行结构分析。`,422);
  return data;
}
export async function getForecastMinuteWindow(symbol:string,source:string,start:number,end:number):Promise<MarketData> {
  try { return await getCryptoMinuteWindow(symbol,source,start,end); }
  catch(error) {
    if(error instanceof CryptoDataError)throw new MarketError(error.message,error.status,error.upstreamStatus);
    throw error;
  }
}
async function cryptoCandles(symbol: string, interval: Interval, limit: number): Promise<MarketData> {
  try { return await getCryptoCandles(symbol, interval, limit); }
  catch (error) {
    if (error instanceof CryptoDataError) throw new MarketError(error.message,error.status,error.upstreamStatus);
    throw error;
  }
}
async function usCandles(symbol: string, interval: Interval, limit: number): Promise<MarketData> {
  const calendar = interval === '1M' || interval === '1w';
  const candidates: (() => Promise<MarketData>)[] = [
    ...(calendar ? [() => usTencentCalendar(symbol,interval,limit)] : []),
    ...(yahooUnavailableUntil>Date.now() ? [] : [async () => {
      try { return await yahooCandles(symbol,interval,limit); }
      catch (error) {
        // A search failure, unknown symbol or malformed interval must not
        // disable the chart service for every other searched instrument.
        if (error instanceof MarketError && [403,429].includes(error.upstreamStatus || 0)) yahooUnavailableUntil=Date.now()+5*60000;
        throw error;
      }
    }]),
    () => usEastmoneyCandles(symbol,interval,limit),
  ];
  return selectStockHistory(candidates);
}
/** All searched stocks use the same source-quality policy. Select one whole
 * response, prioritising current coverage and then usable history depth. */
async function selectStockHistory(candidates:(() => Promise<MarketData>)[]):Promise<MarketData> {
  const results = await Promise.allSettled(candidates.map(candidate => candidate()));
  const data = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const best = chooseEquityHistory(data);
  if (best) return best;
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
  const error = errors.find(error => error instanceof MarketError && error.status === 404) ?? errors[0];
  if (error instanceof MarketError) throw error;
  throw new MarketError('该标的在当前周期暂时没有可用历史行情。');
}
async function yahooCandles(symbol: string, interval: Interval, limit: number): Promise<MarketData> {
  const providerInterval = interval === '1h' ? '60m' : interval === '1w' ? '1wk' : interval === '1M' ? '1mo' : interval;
  const range = interval === '1m' ? '7d' : interval === '1d' ? '5y' : interval === '1h' ? '2y' : '60d';
  // Explicit calendar bounds avoid range=max silently changing monthly bars
  // into quarters. The actual returned granularity is still strictly checked.
  const window = interval === '1w' || interval === '1M'
    ? `period1=${Date.UTC(1900,0,1)/1000}&period2=${Math.floor(Date.now()/1000)+86400}` : `range=${range}`;
  const query = `interval=${providerInterval}&${window}&includePrePost=false&events=div%2Csplits`;
  // First-party website endpoints, not an authorized exchange feed. No retry on denial/limits.
  let data: YahooChart, host = 'query1.finance.yahoo.com';
  try { data = await json<YahooChart>(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`); }
  catch(error) {
    if (error instanceof MarketError && error.status === 404) throw new MarketError('未找到该美股标的。',404);
    if (error instanceof MarketError && [403,429].includes(error.upstreamStatus || 0)) throw error;
    host = 'query2.finance.yahoo.com';
    data = await json<YahooChart>(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`);
  }
  const result = data?.chart?.result?.[0];
  if (!result || data.chart?.error) throw new MarketError('未找到该美股标的或该周期暂无数据。',404);
  const meta = result.meta || {};
  if (meta.exchangeTimezoneName && meta.exchangeTimezoneName !== 'America/New_York') throw new MarketError('该代码不属于美股市场，请重新选择。',422);
  validateYahooGranularity(interval,meta.dataGranularity);
  const q = result.indicators?.quote?.[0];
  if (!q || !Array.isArray(result.timestamp) || ![q.open,q.high,q.low,q.close,q.volume].every(Array.isArray)) throw new MarketError('行情源缺少完整K线。');
  const now = Date.now()/1000;
  const adjust = result.indicators?.adjclose?.[0]?.adjclose;
  const useAdjusted = isCalendarBar(interval) && Array.isArray(adjust);
  const rows: Candle[] = result.timestamp.map((time: number,i: number) => {
    const ratio = useAdjusted && Number(q.close[i]) > 0 && Number(adjust?.[i]) > 0 ? Number(adjust?.[i])/Number(q.close[i]) : 1;
    return {time,open:q.open[i] == null ? NaN : Number(q.open[i])*ratio,high:q.high[i] == null ? NaN : Number(q.high[i])*ratio,low:q.low[i] == null ? NaN : Number(q.low[i])*ratio,close:q.close[i] == null ? NaN : Number(q.close[i])*ratio,volume:q.volume[i] == null ? 0 : Number(q.volume[i]),closed:stockBarClosed(time,interval,'us',now,meta.currentTradingPeriod?.regular?.end)};
  });
  // Yahoo can append a 16:00 instantaneous quote to intraday history. It is
  // not a new hourly/minute OHLC candle and must not enter structure analysis.
  const regularRows = isCalendarBar(interval) ? rows : rows.filter(c => {
    if (!Number.isFinite(c.time) || c.time % 60 !== 0) return false;
    const clock = localClock(c.time,'America/New_York'), minute = clock.hour*60+clock.minute;
    return clock.weekday>=1 && clock.weekday<=5 && minute>=570 && minute<960 && (minute-570)%MINUTES[interval as Exclude<Interval,'1M'>]===0;
  });
  const prepared = interval === '1M' ? normalizeYahooMonthlyCandles(rows,meta.dataGranularity) : interval === '1w' ? normalizeYahooWeeklyCandles(rows,meta.dataGranularity) : regularRows;
  const candles = ensure(prepared,1).slice(-limit);
  const warnings = ['美股正常交易时段数据，不含盘前盘后；公开网页接口可能限流或延迟。','最近K线保守延后15分钟确认；提前收市的日/周K可能延后标为完成。'];
  if (interval === '1m') warnings.push('1分钟K线由真实分钟OHLC构成；Yahoo最多请求最近7天，页面仍受返回数量限制。');
  if (interval === '1M') warnings.push('月线按纽约自然月聚合；当前月在进入下月后才标记已收盘。');
  if (interval === '1M' && rows.length !== prepared.length) warnings.push('已排除行情源追加的日内报价或重复月份，月线仅使用已核验粒度的月首OHLC条目。');
  if (interval === '1w' && rows.length !== prepared.length) warnings.push('已排除行情源追加的当日报价或重复周，周线仅使用已核验周粒度的OHLC条目。');
  if (candles.length<200) warnings.push(`该周期仅有${candles.length}根有效K线，统计样本可能不足。`);
  return {instrument:instrument('us',symbol,meta.longName || meta.shortName || symbol,meta.fullExchangeName || meta.exchangeName || 'US',meta.currency || 'USD'),interval,candles,source:`Yahoo Finance 网页行情 · ${host}`,asOf:new Date(now*1000).toISOString(),delayNotice:'可能延迟，非交易所直连 · America/New_York正常交易时段 · K线为周期起点',adjustment:useAdjusted?'按调整后收盘价等比例调整OHLC（分红、拆股），成交量未调整':'来源原始OHLC；拆股或其他公司行动可能影响历史比较',warnings,availableIntervals:AVAILABLE_INTERVALS.us};
}
export function validateYahooGranularity(interval:Interval,granularity:string|undefined):void {
  const allowed:Record<Interval,string[]>={'1m':['1m'],'5m':['5m'],'15m':['15m'],'30m':['30m'],'1h':['60m','1h'],'4h':['4h'],'1d':['1d'],'1w':['1wk'],'1M':['1mo']};
  if(!granularity||!allowed[interval].includes(granularity))throw new MarketError(`Yahoo实际周期${granularity||'未知'}与请求的${interval}不一致，已拒绝错周期数据。`);
}
function usWeekKey(time:number):string {
  const date=localClock(time,'America/New_York').date;
  const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);
  return d.toISOString().slice(0,10);
}
export function normalizeYahooWeeklyCandles(rows:Candle[],granularity:string|undefined):Candle[] {
  validateYahooGranularity('1w',granularity);
  const weeks=new Map<string,Candle>();
  for(const row of sanitizeCandles(rows)) {
    const key=usWeekKey(row.time);
    // The genuine period bar precedes Yahoo's appended last-session quote.
    if(!weeks.has(key))weeks.set(key,row);
  }
  return [...weeks.values()];
}
/** Yahoo may downsample range=max to quarters and append a daily quote to period data. */
export function normalizeYahooMonthlyCandles(rows:Candle[],granularity:string|undefined):Candle[] {
  if(granularity!=='1mo')throw new MarketError('Yahoo返回周期与月线不一致，未将季度数据作为月线使用。');
  const months=new Map<string,Candle>();
  for(const row of sanitizeCandles(rows)) {
    const date=localClock(row.time,'America/New_York').date;
    // Yahoo native monthly bars are stamped on the first calendar day, whereas
    // appended realtime/day quotes carry their actual trading date/time.
    if(!date.endsWith('-01'))continue;
    const key=date.slice(0,7);
    if(!months.has(key))months.set(key,row);
  }
  return [...months.values()];
}
async function usTencentCalendar(symbol:string,interval:'1w'|'1M',limit:number):Promise<MarketData> {
  const period=interval==='1w'?'week':'month',label=interval==='1w'?'周':'月';
  const metadata=(await usHints(symbol)).find(x=>x.symbol===symbol);
  if(!metadata)throw new MarketError(`腾讯${label}线源未收录该美股代码。`,404);
  const [market,code]=metadata.secid.split('.');
  const suffix:Record<string,string>={'105':'OQ','106':'N','107':'AM'};
  if(!suffix[market])throw new MarketError(`腾讯${label}线源不支持该交易所。`);
  const ticker=`us${code.replace(/_/g,'.')}.${suffix[market]}`;
  const payload=await json<TencentKline>(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${ticker},${period},,,${limit},`);
  const rows=payload.data?.[ticker]?.[period];
  if(payload.code!==0||!Array.isArray(rows))throw new MarketError(`腾讯${label}线源未返回完整${label}OHLC。`);
  const now=Date.now()/1000;
  const candles=ensure(rows.map((r):Candle=>{
    const time=usDateStamp(String(r[0]));
    return {time,open:Number(r[1]),close:Number(r[2]),high:Number(r[3]),low:Number(r[4]),volume:Number(r[5]),closed:stockBarClosed(time,interval,'us',now)};
  }),1).slice(-limit);
  const keys=candles.map(c=>interval==='1w'?usWeekKey(c.time):localClock(c.time,'America/New_York').date.slice(0,7));
  if(new Set(keys).size!==keys.length)throw new MarketError(`腾讯${label}线源返回重复周期，未用于结构分析。`);
  const warnings=[`美股${label}线使用腾讯原生${label}OHLC；不复权历史的拆股和分红可能影响结构，请与其他周期的复权口径对照。`,interval==='1M'?'月份按America/New_York交易日期，当前月进入下月后才标记已收盘。':'周按America/New_York交易日期，当前周在周五正常收盘加15分钟后才确认。',`公开网页行情可能延迟，${label}线时间标记为源最后交易日。`];
  if(candles.length<200)warnings.push(`${label}线源本次返回${candles.length}根，历史统计样本可能不足。`);
  return {instrument:instrument('us',symbol,metadata.name,metadata.exchange,'USD'),interval,candles,source:`腾讯证券 原生美股${label}K · ifzq.gtimg.cn`,asOf:new Date(now*1000).toISOString(),delayNotice:`公开${label}OHLC行情可能延迟 · America/New_York · 周期内最后交易日时间标记`,adjustment:`不复权（${label}度原始OHLC）；成交量单位：股`,warnings,availableIntervals:AVAILABLE_INTERVALS.us};
}
async function usEastmoneyCandles(symbol: string, interval: Interval, limit: number): Promise<MarketData> {
  const metadata = (await usHints(symbol)).find(x=>x.symbol===symbol);
  if (!metadata) throw new MarketError('Yahoo行情不可用，备用源未收录该美股代码；请核对代码或稍后重试。',404);
  const klt = eastmoneyPeriod(interval);
  const params = new URLSearchParams({secid:metadata.secid,klt,fqt:'0',lmt:String(limit+1),end:'20500101',fields1:'f1,f2,f3,f4,f5,f6',fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'});
  const payload = await json<EastmoneyData>(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`);
  const result = payload?.data;
  if (!result || !Array.isArray(result.klines) || `${result.market}.${result.code}`!==metadata.secid) throw new MarketError('备用行情源未返回该美股标的的有效数据。',404);
  const now = Date.now()/1000, intraday=!isCalendarBar(interval);
  const rows: Candle[] = result.klines.filter(raw=>typeof raw==='string').map((raw: string) => {
    const r=raw.split(',');
    // The alternate source uses Shanghai-time END stamps for US minute candles.
    const time=intraday?Date.parse(r[0].replace(' ','T')+':00+08:00')/1000:usDateStamp(r[0]);
    return {time,open:Number(r[1]),close:Number(r[2]),high:Number(r[3]),low:Number(r[4]),volume:Number(r[5]),closed:intraday?now>=time+900:stockBarClosed(time,interval,'us',now)};
  }).filter((c: Candle)=>{
    if (!Number.isFinite(c.time)) return false;
    if (!intraday) return true;
    const clock=localClock(c.time,'America/New_York'), minute=clock.hour*60+clock.minute;
    return clock.weekday>=1 && clock.weekday<=5 && minute>570 && minute<=960;
  });
  // The earliest minute candle can be truncated by the provider's retention window.
  const candles=ensure(intraday && interval !== '1m' ? rows.slice(1) : rows,1).slice(-limit);
  const warnings=['已使用东方财富美股公开行情源；公开网页接口可能限流或延迟。','备用源采用不复权价格，除权除息和拆股可能影响结构；不同来源结果可能不同。','仅正常交易时段；最近K线延后15分钟确认。'];
  if (intraday) warnings.push('分钟K线保留源时间标记（周期结束），已转换为UTC；纽约时区筛选正常交易时段，免费历史窗口有限。');
  if (interval === '1m') warnings.push('备用源1分钟真实OHLC仅覆盖最近一个交易日；不会把只有收盘价的分时数据伪造成K线。');
  if (interval === '1M') warnings.push('月线按纽约自然月聚合；当前月在进入下月后才标记已收盘。');
  if (candles.length<200) warnings.push(`行情源本次仅返回${candles.length}根K线，历史统计样本可能不足。`);
  return {instrument:instrument('us',symbol,result.name||metadata.name,metadata.exchange,'USD'),interval,candles,source:'东方财富 美股网页行情（备用） · push2his.eastmoney.com',asOf:new Date(now*1000).toISOString(),delayNotice:'延迟行情，非交易所直连 · America/New_York正常交易时段 · 分钟K线为周期结束',adjustment:'不复权（原始价格）；成交量单位：股',warnings,availableIntervals:AVAILABLE_INTERVALS.us};
}
async function cnCandles(symbol: string, interval: Interval, limit: number): Promise<MarketData> {
  const fallbacks = isCalendarBar(interval) && !symbol.endsWith('.BJ') ? [cnTencentCandles,cnSinaCandles] : [cnSinaCandles,cnTencentCandles];
  return selectStockHistory([
    ...(cnEastmoneyUnavailableUntil > Date.now() ? [] : [async () => {
      try { return await cnEastmoneyCandles(symbol,interval,limit); }
      catch (error) {
        if (error instanceof MarketError && [403,429].includes(error.upstreamStatus || 0)) cnEastmoneyUnavailableUntil=Date.now()+5*60000;
        throw error;
      }
    }]),
    ...fallbacks.map(fallback => () => fallback(symbol,interval,limit)),
  ]);
}
async function cnEastmoneyCandles(symbol: string, interval: Interval, limit: number): Promise<MarketData> {
  const [code,exchange] = symbol.split('.');
  const secid = `${exchange === 'SH' ? '1' : '0'}.${code}`;
  const klt = eastmoneyPeriod(interval);
  const params = new URLSearchParams({secid,klt,fqt:'0',lmt:String(limit),end:'20500101',fields1:'f1,f2,f3,f4,f5,f6',fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'});
  const payload = await json<EastmoneyData>(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`);
  const result = payload?.data;
  if (!result || !Array.isArray(result.klines) || result.code !== code || Number(result.market) !== (exchange==='SH'?1:0)) throw new MarketError('未找到该A股标的或该周期暂无行情。',404);
  const now = Date.now()/1000;
  const rows: Candle[] = result.klines.filter(raw=>typeof raw==='string').map((raw: string) => {
    const r = raw.split(',');
    const stamp = r[0].includes(' ') ? r[0].replace(' ','T')+':00+08:00' : r[0]+'T09:30:00+08:00';
    const time = Date.parse(stamp)/1000;
    return {time,open:Number(r[1]),close:Number(r[2]),high:Number(r[3]),low:Number(r[4]),volume:Number(r[5])*100,closed:stockBarClosed(time,interval,'cn',now)};
  });
  const candles = ensure(rows,1).slice(-limit);
  const warnings = ['A股展示看多/看空倾向；看空信号不代表该标的可以直接卖空。','不复权历史包含除权除息跳空，可能影响分型和背驰比较。'];
  if (!isCalendarBar(interval)) warnings.push('免费分钟K线历史窗口有限；时间标记为周期结束，成交量已由手换算为股。');
  if (interval === '1m') warnings.push('1分钟真实OHLC仅覆盖最近一个交易日；刚开盘时结构样本较少。');
  if (interval === '1M') warnings.push('月线按上海自然月聚合；当前月在进入下月后才标记已收盘。');
  if (candles.length<200) warnings.push(`行情源本次仅返回${candles.length}根K线，历史统计样本可能不足。`);
  return {instrument:instrument('cn',symbol,result.name || code,exchange==='SH'?'上交所':exchange==='BJ'?'北交所':'深交所','CNY'),interval,candles,source:'东方财富 网页行情 · push2his.eastmoney.com',asOf:new Date(now*1000).toISOString(),delayNotice:'可能延迟，非交易所直连 · Asia/Shanghai · 仅交易时段',adjustment:'不复权（原始价格）；成交量单位：股',warnings,availableIntervals:AVAILABLE_INTERVALS.cn};
}

function cnInstrument(symbol:string, name?:string):Instrument {
  const [code,exchange]=symbol.split('.');
  return instrument('cn',symbol,name||popular('cn',symbol)[0]?.name||code,exchange==='SH'?'上交所':exchange==='BJ'?'北交所':'深交所','CNY');
}
function cnPrefix(symbol:string):string {
  const [code,exchange]=symbol.split('.');return `${exchange.toLowerCase()}${code}`;
}
interface TencentKline {code?:number; data?:Record<string,{day?:unknown[][];week?:unknown[][];month?:unknown[][];m1?:unknown[][];m5?:unknown[][];m15?:unknown[][];m30?:unknown[][];m60?:unknown[][];qt?:Record<string,string[]>}>}
async function cnTencentCandles(symbol:string,interval:Interval,limit:number):Promise<MarketData> {
  const ticker=cnPrefix(symbol), calendar=isCalendarBar(interval);
  const period=interval==='1M'?'month':interval==='1w'?'week':interval==='1d'?'day':interval==='1h'?'m60':`m${MINUTES[interval as Exclude<Interval,'1M'>]}`;
  const url=calendar?`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${ticker},${period},,,${limit},`:`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${ticker},${period},,${limit}`;
  const payload=await json<TencentKline>(url),data=payload.data?.[ticker];
  const rows=data?.[period as 'day'];
  if(payload.code!==0||!data||!Array.isArray(rows))throw new MarketError('腾讯备用源暂无该标的K线。');
  const now=Date.now()/1000;
  const parsed=rows.map((r):Candle=>{
    const raw=String(r[0]);
    const stamp=calendar?`${raw}T09:30:00+08:00`:/^\d{12}$/.test(raw)?`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T${raw.slice(8,10)}:${raw.slice(10,12)}:00+08:00`:'';
    const time=Date.parse(stamp)/1000;
    return {time,open:Number(r[1]),close:Number(r[2]),high:Number(r[3]),low:Number(r[4]),volume:Number(r[5])*100,closed:stockBarClosed(time,interval,'cn',now)};
  });
  const candles=ensure(parsed,1).slice(-limit);
  const warnings=['已使用独立腾讯K线源；不同来源的历史和复权口径可能不同。','A股看空不代表可以直接卖空。'];
  if(!calendar)warnings.push('腾讯分钟K线保留源周期结束时间；分钟历史的复权口径未独立核验。');
  if(interval==='1M')warnings.push('当前月在进入上海时区下月后才标记已收盘。');
  if(candles.length<200)warnings.push(`备用源返回${candles.length}根K线，统计样本可能不足。`);
  return {instrument:cnInstrument(symbol,data.qt?.[ticker]?.[1]),interval,candles,source:'腾讯证券 K线（独立备用） · ifzq.gtimg.cn',asOf:new Date(now*1000).toISOString(),delayNotice:'公开网页行情可能延迟 · Asia/Shanghai · 分钟K线标记周期结束',adjustment:calendar?'不复权（日/周/月原始价格）；成交量单位：股':'来源分钟OHLC（复权口径未独立核验）；成交量单位：股',warnings,availableIntervals:AVAILABLE_INTERVALS.cn};
}

/** Aggregate genuine daily OHLC only; drop the first bucket because retention may start mid-period. */
export function aggregateChinaCalendar(daily:Candle[],interval:'1w'|'1M',now=Date.now()/1000):Candle[] {
  const groups=new Map<string,Candle>();
  for(const c of sanitizeCandles(daily)) {
    const date=localClock(c.time,'Asia/Shanghai').date;
    let key=date.slice(0,7);
    if(interval==='1w') {
      const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);key=d.toISOString().slice(0,10);
    }
    const prior=groups.get(key);
    if(prior) {prior.high=Math.max(prior.high,c.high);prior.low=Math.min(prior.low,c.low);prior.close=c.close;prior.volume+=c.volume;}
    else groups.set(key,{...c});
  }
  return [...groups.values()].slice(1).map(c=>({...c,closed:stockBarClosed(c.time,interval,'cn',now)}));
}
interface SinaRow {day:string;open:string;high:string;low:string;close:string;volume:string}
async function cnSinaCandles(symbol:string,interval:Interval,limit:number):Promise<MarketData> {
  const ticker=cnPrefix(symbol),calendar=isCalendarBar(interval);
  const scale=calendar?240:MINUTES[interval as Exclude<Interval,'1M'>];
  const count=interval==='1M'||interval==='1w'?1023:Math.min(1023,limit);
  const url=`https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_data=/CN_MarketDataService.getKLineData?symbol=${ticker}&scale=${scale}&ma=no&datalen=${count}`;
  const text=await upstream(url),body=text.match(/\b_data\s*=\s*\(([\s\S]*)\);?\s*$/)?.[1];
  if(!body)throw new MarketError('新浪备用源返回格式异常。');
  let raw:SinaRow[];
  try {raw=JSON.parse(body) as SinaRow[];}catch {throw new MarketError('新浪备用源返回格式异常。');}
  if(!Array.isArray(raw))throw new MarketError('新浪备用源暂无该标的数据。');
  const now=Date.now()/1000;
  const rows=raw.filter(r=>r&&typeof r.day==='string').map((r):Candle=>{
    const stamp=r.day.includes(' ')?`${r.day.replace(' ','T')}+08:00`:`${r.day}T09:30:00+08:00`;
    const time=Date.parse(stamp)/1000;
    return {time,open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:Number(r.volume),closed:stockBarClosed(time,calendar?'1d':interval,'cn',now)};
  });
  const aggregated=interval==='1M'||interval==='1w';
  const candles=ensure(aggregated?aggregateChinaCalendar(rows,interval,now):rows,1).slice(-limit);
  const warnings=['已使用独立新浪OHLC行情源；历史长度取决于来源保留窗口。','A股看空不代表可以直接卖空。'];
  if(aggregated)warnings.push('按新浪真实日OHLC聚合，已丢弃起始不完整周期；日线入库可能滞后，最新交易日可能尚未包含。');
  if(calendar)warnings.push('新浪日线可能只更新到上一个已完成交易日，请核对图表末端时间。');
  if(interval==='1M')warnings.push('当前月在进入上海时区下月后才标记已收盘。');
  if(candles.length<200)warnings.push(`备用源返回${candles.length}根K线，统计样本可能不足。`);
  return {instrument:cnInstrument(symbol),interval,candles,source:'新浪财经 OHLC（独立备用） · quotes.sina.cn',asOf:new Date(now*1000).toISOString(),delayNotice:'公开网页行情可能延迟 · Asia/Shanghai · 分钟K线标记周期结束',adjustment:'来源原始OHLC（未请求复权）；成交量单位：股',warnings,availableIntervals:AVAILABLE_INTERVALS.cn};
}
