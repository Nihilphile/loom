import {randomUUID} from 'node:crypto';
import type {AppState,HarnessEvent,ProjectState,Runtime,GitAdapter,Session} from '../shared/types.ts';
import {emptyMetrics} from '../shared/types.ts';
import {ProjectStore} from './store.ts';
import {Catalog} from './catalog.ts';

export class HarnessEngine {
  state:ProjectState;
  readonly store:ProjectStore;
  readonly listeners=new Set<()=>void>();
  constructor(root:string,readonly runtime:Runtime,readonly git:GitAdapter,readonly catalog:Catalog){
    this.store=new ProjectStore(root);this.state=this.store.load();
    this.store.save(this.state);
  }
  view():AppState{return structuredClone({project:this.state.project,sessions:this.state.sessions,graphs:this.state.graphs,letters:this.state.letters,agentTemplates:this.catalog.agents,taskTypes:this.catalog.taskTypes,runtime:{name:this.runtime.name,capabilities:this.runtime.capabilities}});}
  record(type:string,message:string,extra:Partial<HarnessEvent>={}){this.store.save(this.state,{at:new Date().toISOString(),type,message,...extra});for(const f of this.listeners)f();}
  createSession(input:{title:string;model?:string;reasoning?:Session['reasoning']}):Session {
    if(!input.title?.trim())throw new Error('会话标题不能为空');
    const session:Session={id:randomUUID(),title:input.title.trim(),kind:'free',status:'idle',model:input.model,reasoning:input.reasoning,messages:[],metrics:emptyMetrics(),turns:0};
    this.state.sessions.push(session);this.record('session.created','创建自由会话',{sessionId:session.id});return session;
  }
  close(){this.store.close();}
}
