import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarketError, getCandles, getForecastMinuteWindow, searchInstruments, parseMarket, parseSearchMarket, parseInterval, resetMarketNetworkFailures } from './market-data.mjs';
import { createNetworkRouteMonitor } from './network-bootstrap.mjs';

// Market adapters perform no requests at module load. Configure the existing
// user network route before starting the listener or making any market request.
const checkNetworkRoute=createNetworkRouteMonitor({onRouteChange:resetMarketNetworkFailures});
await checkNetworkRoute();

async function marketRequest(load){
  const route=await checkNetworkRoute();
  try{return await load();}catch(error){
    if(error instanceof MarketError&&error.status<500)throw error;
    // Retry once if the OS route changed during the failed request.
    if((await checkNetworkRoute(true)).revision===route.revision)throw error;
    return load();
  }
}

const appRoot=dirname(fileURLToPath(import.meta.url));
const publicRoot=resolve(appRoot,'public');
const portIndex=process.argv.indexOf('--port');
const requestedPort=portIndex<0?43127:Number(process.argv[portIndex+1]);
if(!Number.isInteger(requestedPort)||(requestedPort!==0&&requestedPort<1024)||requestedPort>65535)throw new Error('Invalid local port');
let port,origin;
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png','.json':'application/json; charset=utf-8'};
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const windows=new Set();
let exitTimer;
function shutdown(){
  console.log('No workbench windows remain. Stopping local service.');
  for(const window of windows)window.end();
  server.closeAllConnections();
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(0),1000).unref();
}
function scheduleExit(ms){clearTimeout(exitTimer);exitTimer=setTimeout(shutdown,ms);}

const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  // Loopback binding and an exact Host/Origin prevent unrelated web pages from
  // using this desktop service. The service holds no account credentials.
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host||''))return json(res,403,{error:'Local host only'});
  if(req.headers.origin&&![origin,`http://localhost:${port}`].includes(req.headers.origin))return json(res,403,{error:'Local origin only'});
  if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'Read-only endpoint'});
  try{
    const url=new URL(req.url||'/',origin);
    if(url.pathname==='/health')return json(res,200,{app:'trend-workbench',version:'1.3-local',pid:process.pid,activeWindows:windows.size,autoExit:true});
    if(url.pathname==='/session'){
      if(req.method!=='GET')return json(res,405,{error:'GET required'});
      clearTimeout(exitTimer);
      windows.add(res);
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
      res.write('event: connected\ndata: local-workbench\n\n');
      const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),15000);
      res.on('close',()=>{clearInterval(heartbeat);windows.delete(res);if(!windows.size)scheduleExit(5000);});
      return;
    }
    if(url.pathname==='/api/search'){
      const q=url.searchParams.get('q')||'';
      if(q.length>60)throw new MarketError('搜索内容最多60个字符。',400);
      const market=parseSearchMarket(url.searchParams.get('market'));
      return json(res,200,await marketRequest(()=>searchInstruments(market,q)));
    }
    if(url.pathname==='/api/candles'){
      const market=parseMarket(url.searchParams.get('market'));
      const interval=parseInterval(url.searchParams.get('interval')||'1d',market);
      const symbol=url.searchParams.get('symbol');
      if(!symbol)throw new MarketError('缺少标的代码。',400);
      const limit=Number(url.searchParams.get('limit')||'800');
      if(!Number.isInteger(limit)||limit<1||limit>2000)throw new MarketError('K线数量须为1至2000。',400);
      return json(res,200,await marketRequest(()=>getCandles(market,symbol,interval,limit)));
    }
    if(url.pathname==='/api/forecast-minute-window'){
      const {searchParams}=url;
      const symbol=searchParams.get('symbol'),source=searchParams.get('source');
      if(!symbol||!source)throw new MarketError('缺少原记录的交易对或来源。',400);
      const start=Number(searchParams.get('start')),end=Number(searchParams.get('end'));
      return json(res,200,await marketRequest(()=>getForecastMinuteWindow(symbol,source,start,end)));
    }
    if(url.pathname.startsWith('/api/'))return json(res,404,{error:'Unknown endpoint'});
    let decoded;
    try{decoded=decodeURIComponent(url.pathname);}catch{return json(res,400,{error:'Invalid URL'});}
    if(decoded.includes('\\')||decoded.includes('\0'))return json(res,400,{error:'Invalid path'});
    const asset=resolve(publicRoot,'.'+(decoded==='/'?'/index.html':decoded));
    const rel=relative(publicRoot,asset);
    if(rel.startsWith('..')||!rel)return json(res,404,{error:'Not found'});
    const info=await stat(asset);
    if(!info.isFile())return json(res,404,{error:'Not found'});
    const type=mime[extname(asset)];
    if(!type)return json(res,404,{error:'Not found'});
    res.writeHead(200,{'Content-Type':type,'Content-Length':info.size,'Cache-Control':'no-cache'});
    res.end(req.method==='HEAD'?undefined:await readFile(asset));
  }catch(error){
    if(error?.code==='ENOENT')return json(res,404,{error:'Not found'});
    const status=error instanceof MarketError?error.status:502;
    json(res,status,{error:error instanceof Error?error.message:'本机服务暂时无法取得行情。'});
  }
});
server.requestTimeout=60000;
server.headersTimeout=15000;
server.on('error',error=>{console.error(error.code||error.message);process.exitCode=1;});
server.listen(requestedPort,'127.0.0.1',()=>{
  port=server.address().port;
  origin=`http://127.0.0.1:${port}`;
  if(process.argv.includes('--announce-ready'))console.log(`TREND_WORKBENCH_READY ${port}`);
  console.log(`Trend Workbench ${origin} · pid ${process.pid}`);
  scheduleExit(90000);
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,shutdown);
