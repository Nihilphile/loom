export type Reasoning = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type Outcome = 'ready' | 'approved' | 'changes_requested' | 'blocked';
export interface Usage { inputTokens: number; cachedInputTokens: number; outputTokens: number; }
export interface Metrics { seconds: number; toolCalls: number; usage: Usage; costUsd: number | null; }
export interface AgentTemplate { id: string; name: string; version: number; model?: string; reasoning?: Reasoning; skills: string[]; prompt: string; readOnly: boolean; }
export interface UnitConfig { id: string; name: string; kind: 'agent' | 'command'; templateId?: string; model?: string; reasoning?: Reasoning; skills: string[]; prompt: string; readOnly: boolean; command?: string; }
export interface TaskRule { from: string; outcome: Outcome; action: {type: 'activate'; unit: string} | {type:'finish'} | {type:'block'}; }
export interface TaskType { id: string; name: string; version: number; units: UnitConfig[]; start: string[]; rules: TaskRule[]; maxRounds: number; maxReportRetries: number; }
export interface ChatMessage { id: string; role: 'user' | 'assistant' | 'system' | 'mailbox'; text: string; at: string; }
export interface Session { id: string; title: string; kind: 'free' | 'task'; graphId?: string; taskId?: string; unitId?: string; threadId?: string; status:'idle'|'running'|'interrupted'|'failed'; model?: string; reasoning?: Reasoning; messages: ChatMessage[]; metrics: Metrics; turns: number; error?: string; }
export interface Unit extends UnitConfig { sessionId?: string; status:'waiting'|'running'|'idle'|'interrupted'|'failed'; metrics: Metrics; reportRetries: number; }
export interface Workspace { path: string; branch: string; baseCommit: string; }
export interface Snapshot { sha:string; kind:'candidate'|'delivery'; submissionId:string; at:string; }
export interface Submission { id:string; executionId:string; graphId:string; taskId:string; unitId:string; outcome:Outcome; reportPath:string; content:string; digest:string; key:string; at:string; }
export interface TaskInput { id?:string; title:string; goal:string; deps:string[]; taskTypeId:string; newWorktree?:boolean; }
export interface Task { id:string; title:string; goal:string; deps:string[]; newWorktree:boolean; type:TaskType; units:Unit[]; status:'waiting'|'preparing'|'running'|'reviewing'|'awaiting'|'blocked'|'done'|'queued'; workspace?:Workspace; snapshots:Snapshot[]; submissions:Submission[]; round:number; blockReason?:string; nextUnit?:string; candidateSha?:string; deliverySha?:string; appendBarrier?:string[]; configRevision:number; }
export interface GraphInput { name:string; tasks:TaskInput[]; concurrency?:number; }
export interface Graph { id:string; name:string; runId?:string; status:'draft'|'running'|'pausing'|'paused'|'merging'|'blocked'|'done'; pauseMode?:'soft'|'hard'; concurrency:number; tasks:Task[]; workspace?:Workspace; finalSha?:string; error?:string; createdAt:string; subscription:'blocked'|'completed'|'review'; controllerSessionId?:string; }
export interface LetterInput { graphId:string; from:string; to:string[]; title:string; path:string; mode?:'auto'|'steer'|'followup'; }
export interface Letter extends LetterInput { id:string; content:string; digest:string; createdAt:string; deliveries:{to:string; status:'queued'|'injected'|'failed'; at?:string; sessionId?:string; error?:string}[]; }
export interface HarnessEvent { id:number; at:string; type:string; message:string; sessionId?:string; graphId?:string; taskId?:string; unitId?:string; detail?:unknown; }
export interface Execution { id:string; sessionId:string; graphId?:string; taskId?:string; unitId?:string; purpose:'chat'|'work'|'report'|'mail'; originUnit?:string; tokenHash?:string; status:'starting'|'running'|'completed'|'failed'|'interrupted'; threadId?:string; startedAt:string; endedAt?:string; submissionId?:string; configRevision?:number; pid?:number; error?:string; }
export interface ProjectState { version:1; project:{path:string; name:string}; sessions:Session[]; graphs:Graph[]; letters:Letter[]; executions:Execution[]; }
export interface AppState { project:ProjectState['project']|null; sessions:Session[]; graphs:Graph[]; letters:Letter[]; agentTemplates:AgentTemplate[]; taskTypes:TaskType[]; runtime:{name:string; capabilities:RuntimeCapabilities}; }
export interface RuntimeCapabilities { inject:boolean; interrupt:boolean; readOnly:boolean; }
export interface RuntimeInput { cwd:string; prompt:string; threadId?:string; model?:string; reasoning?:Reasoning; readOnly?:boolean; writableRoots?:string[]; env?:Record<string,string>; }
export interface RuntimeEvent { type:string; threadId?:string; text?:string; itemId?:string; detail?:unknown; usage?:Usage; }
export interface RuntimeResult { status:'completed'|'interrupted'|'failed'; threadId?:string; text:string; usage?:Usage; error?:string; }
export interface RuntimeHandle { done:Promise<RuntimeResult>; pid?:number; interrupt():Promise<void>; inject(text:string):Promise<boolean>; }
export interface Runtime { name:string; capabilities:RuntimeCapabilities; start(input:RuntimeInput,onEvent:(event:RuntimeEvent)=>void):Promise<RuntimeHandle>; close?():Promise<void>; }
export interface GitAdapter { createGraph(projectRoot:string,graphId:string,runId:string):Promise<Workspace>; createTask(graph:Workspace,taskId:string,dependencyShas:string[]):Promise<Workspace>; snapshot(workspace:Workspace,message:string,operationId:string):Promise<string>; mergeFinal(workspace:Workspace,shas:string[],operationId:string):Promise<string>; }
export const emptyMetrics = (): Metrics => ({seconds:0,toolCalls:0,usage:{inputTokens:0,cachedInputTokens:0,outputTokens:0},costUsd:null});
