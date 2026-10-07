import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, realpathSync, statSync} from 'node:fs';
import {basename, join} from 'node:path';
import type {HarnessEvent, ProjectState} from '../shared/types.ts';

export class ProjectStore {
  readonly root:string;
  private db:DatabaseSync;
  constructor(root:string) {
    this.root=realpathSync(root);
    if(!statSync(this.root).isDirectory())throw new Error('项目路径必须是目录');
    for(const dir of ['', '.session','taskgraph','reports'])mkdirSync(join(this.root,'.newharness',dir),{recursive:true});
    this.db=new DatabaseSync(join(this.root,'.newharness','state.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)');
  }
  load():ProjectState {
    const row=this.db.prepare('SELECT value FROM state WHERE id=1').get();
    if(row)return JSON.parse(String(row.value)) as ProjectState;
    return {version:1,project:{path:this.root,name:basename(this.root)},sessions:[],graphs:[],letters:[],executions:[]};
  }
  save(state:ProjectState,event?:Omit<HarnessEvent,'id'>):HarnessEvent|undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(state));
      let saved:HarnessEvent|undefined;
      if(event){const result=this.db.prepare('INSERT INTO events(value) VALUES(?)').run(JSON.stringify(event));saved={...event,id:Number(result.lastInsertRowid)};}
      this.db.exec('COMMIT');return saved;
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  events(filter:{sessionId?:string;graphId?:string;after?:number}={}):HarnessEvent[] {
    const rows=this.db.prepare('SELECT id,value FROM events WHERE id>? ORDER BY id LIMIT 10000').all(filter.after||0);
    return rows.map(row=>({...JSON.parse(String(row.value)),id:Number(row.id)}) as HarnessEvent).filter(e=>(!filter.sessionId||e.sessionId===filter.sessionId)&&(!filter.graphId||e.graphId===filter.graphId));
  }
  close(){this.db.close();}
}
