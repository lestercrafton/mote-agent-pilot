import { httpServer } from './http.mjs';
import { assert } from './protocol.mjs';
export const USDC_MANIFEST = '/.well-known/mote-usdc.json';
export const USDC_PATH = '/v1/usdc/audit';

// Legacy request callback is retained verbatim. No URL/body/header rewrite and no second listening port.
export function installCombinedRoutes({ legacy, usdc = null }) {
  const server=legacy.transport.server;
  const listeners=server.listeners('request'); assert(listeners.length===1,'LEGACY_HANDLER');
  if(usdc) assert(usdc.c.path===USDC_PATH,'USDC_ROUTE_IDENTITY');
  const temporary=usdc?httpServer(usdc,{manifestPath:USDC_MANIFEST,healthPath:'/v1/usdc/health',maxPaymentHeaderBytes:12000}):null;
  const paid=temporary?.listeners('request')[0];
  server.maxConnections=32;
  server.removeListener('request',listeners[0]);
  const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
  server.on('request',async(req,res)=>{
    try {
      if(req.method==='GET'&&req.url==='/ready') {
        const old=await legacy.service.readiness();
        let u={enabled:false,newAdmissionAllowed:false,recoveryAvailable:false};
        if(usdc) { try { u={enabled:true,...usdc.j.readiness()}; } catch { u={enabled:true,recoveryAvailable:false,newAdmissionAllowed:false}; } }
        return json(res,old.ready===true&&(!u.enabled||u.recoveryAvailable)?200:503,{...old,testOnly:!usdc||usdc.c.network!=='eip155:8453',legacyTestOnly:true,usdc:{...u,network:usdc?.c.network??null},productionReady:false});
      }
      const reserved=req.url===USDC_MANIFEST||req.url?.startsWith(USDC_MANIFEST+'?')||req.url==='/v1/usdc'||req.url?.startsWith('/v1/usdc/');
      if(reserved) {
        if(!usdc) return json(res,req.method==='GET'&&req.url===USDC_MANIFEST?200:503,{service:'Mote USDC',enabled:false,productionReady:false,reason:'USDC_NOT_ACTIVATED'});
        if(!(req.method==='GET'&&[USDC_MANIFEST,'/v1/usdc/health'].includes(req.url))&&!(req.method==='POST'&&req.url===USDC_PATH))return json(res,404,{error:'ROUTE'});
        return paid(req,res);
      }
      return listeners[0].call(server,req,res);
    } catch { if(!res.headersSent)json(res,503,{error:'COMBINED_UNAVAILABLE'});else res.destroy(); }
  });
  return { async close(){temporary?.closeAllConnections();usdc?.shutdown?.();usdc?.j.close();await legacy.close();} };
}
