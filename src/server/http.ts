import {createServer,type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import {HarnessEngine} from './engine.ts';
import {Catalog} from './catalog.ts';
import type {Runtime,GitAdapter,AppState} from '../shared/types.ts';

export async function createHttpServer(options:{runtime:Runtime;git:GitAdapter;catalogPath?:string;projectRoot?:string;staticDir?:string}){
  const catalog=new Catalog(options.catalogPath),streams=new Set<ServerResponse>();
  let engine:HarnessEngine|undefined;
  const view=():AppState=>engine?.view()||{project:null,sessions:[],graphs:[],letters:[],agentTemplates:catalog.agents,taskTypes:catalog.taskTypes,runtime:{name:options.runtime.name,capabilities:options.runtime.capabilities}};
  const broadcast=()=>{const message='event: state\ndata: '+JSON.stringify(view())+'\n\n';for(const stream of streams)stream.write(message);};
  const open=(path:string)=>{if(engine?.state.sessions.some(s=>s.status==='running'))throw new Error('请先停止当前项目的活动执行');engine?.close();engine=new HarnessEngine(path,options.runtime,options.git,catalog);engine.listeners.add(broadcast);broadcast();};
  if(options.projectRoot)open(options.projectRoot);
  const server=createServer(async(req,res)=>{
    const json=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try{
      const host=req.headers.host||'';if(!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)){json(403,{error:'只允许本地访问'});return;}
      if(req.headers.origin&&new URL(req.headers.origin).host!==host){json(403,{error:'跨站请求被拒绝'});return;}
      const url=new URL(req.url||'/',`http://${host}`),path=url.pathname;
      if(path==='/api/stream'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('event: state\ndata: '+JSON.stringify(view())+'\n\n');streams.add(res);req.on('close',()=>streams.delete(res));return;}
      if(req.method==='GET'&&path==='/api/state'){json(200,view());return;}
      let body:Record<string,any>={};
      if(['POST','PATCH'].includes(req.method||'')){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1_000_000)throw new Error('请求过大');}body=raw?JSON.parse(raw):{};}
      if(req.method==='POST'&&path==='/api/project'){if(typeof body.path!=='string')throw new Error('缺少项目路径');open(body.path);json(200,view());return;}
      if(path.startsWith('/api/')){
        if(!engine){json(409,{error:'请先打开项目'});return;}
        if(req.method==='POST'&&path==='/api/sessions'){json(201,engine.createSession(body as {title:string}));return;}
        if(req.method==='GET'&&path==='/api/events'){json(200,engine.store.events({sessionId:url.searchParams.get('sessionId')||undefined,graphId:url.searchParams.get('graphId')||undefined,after:Number(url.searchParams.get('after')||0)}));return;}
        json(404,{error:'接口不存在'});return;
      }
      const base=resolve(options.staticDir||'dist/web'),file=resolve(base,path==='/'?'index.html':'.'+path);
      if(file!==base&&!file.startsWith(base+sep)){json(403,{error:'路径越界'});return;}
      try{const content=await readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'} as Record<string,string>)[extname(file)]||'application/octet-stream'});res.end(content);}catch{res.writeHead(404);res.end('Run npm run build to prepare the Web UI.');}
    }catch(error){json(400,{error:error instanceof Error?error.message:String(error)});}
  });
  return {server,get engine(){return engine;},close:async()=>{for(const s of streams)s.end();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));engine?.close();await options.runtime.close?.();}};
}
