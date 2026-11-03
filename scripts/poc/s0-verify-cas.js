// scripts/poc/s0-verify-cas.js — 验证任务更新的 CAS 语义（S0 第五轮，U-4）。
//
// 第一性原理：为什么 CAS 是多人改同一张任务板的安全前提
//
//   官方 UpdateTeamTaskRequest 带 expectedRevision。如果它只是装饰，
//   那么两个成员（或人与成员）先后更新同一任务时，后写的会覆盖先写的，
//   而且**没有任何人会发现**——这比报错更糟。
//
//   探针的做法：先让任务 revision 从 1 涨到 3，然后**用旧的 revision 1**
//   再更新一次。如果 CAS 生效，状态必须完全不变。
//
//   实测（2026-11-04，0.2.1-rc.5 + 真实模型）：
//     task created revision=1
//     after update revision=3 status=completed
//     after stale-revision attempt revision=3 status=completed  <- 未变
//     RESULT: CAS ENFORCED
//
//   含义：我们可以放心地把 revision 原样透传给 UI，
//   让改任务携带它，而不需要自己实现乐观锁。
//
const { spawn }=require('node:child_process'); const http=require('node:http'); const path=require('node:path'); const crypto=require('node:crypto');
const ROOT=process.argv[2]; const REPO='/Users/xia/program/dsh/DshCockpit';
const env=()=>({...process.env,DSH_HOME:path.join(ROOT,'dsh-home'),DSH_POC_ISOLATED:'1',npm_config_cache:path.join(ROOT,'npm-cache'),DSH_PRIMARY_RUNTIME:path.join(ROOT,'dsh-home')});
function get(u,h={}){return new Promise(r=>{const q=http.get(u,{headers:h},s=>{let b='';s.on('data',c=>b+=c);s.on('end',()=>r({status:s.statusCode,headers:s.headers,body:b}))});q.on('error',e=>r({status:0,headers:{},body:String(e.message)}));q.setTimeout(20000,()=>{q.destroy();r({status:0,headers:{},body:'timeout'})})})}
function boot(bin){return new Promise(r=>{const c=spawn(process.execPath,[bin,'--profile','web','--port','0','--no-open'],{env:env(),stdio:['ignore','pipe','pipe']});let b='';let d=false;const t=setTimeout(()=>{if(!d){d=true;try{c.kill('SIGKILL')}catch{}r({error:'timeout'})}},90000);const on=x=>{b+=String(x);const m=b.match(/https?:\/\/[^\s"']+/);if(m&&!d){d=true;clearTimeout(t);r({url:m[0],child:c})}};c.stdout.on('data',on);c.stderr.on('data',on);c.on('exit',code=>{if(!d){d=true;clearTimeout(t);r({error:'exit '+code})}})})}
function unwrap(r){return r&&r.value!==undefined?r.value:r}
async function team(mux,sid){const p=unwrap(await mux.call('session/projections',{request:{sessionId:sid}}));return (p&&p.values&&p.values.agentTeam)||null}
async function waitFor(fn,ms){const end=Date.now()+ms;while(Date.now()<end){const v=await fn().catch(()=>null);if(v)return v;await new Promise(r=>setTimeout(r,3000))}return null}
(async()=>{
 const bin=path.join(ROOT,'runtime-install/node_modules/@deepseek-ai/dsh/lib/bin.js');
 const b=await boot(bin); if(b.error){console.log('BOOT FAIL',b.error);process.exit(1)}
 const res=await get(b.url); const sc=res.headers['set-cookie'];
 const cookie=(Array.isArray(sc)?sc:[sc]).map(c=>String(c).split(';')[0]).join('; ');
 const {createRuntimeMux}=require(path.join(REPO,'src/runtime-mux.js'));
 const mux=await new Promise((res2,rej)=>{const m=createRuntimeMux({baseUrl:new URL(b.url).origin,auth:{getCookie:async()=>cookie,invalidate(){}},log(){},onError(){}});const t=setTimeout(()=>rej(new Error('timeout')),25000);m.onReady(()=>{clearTimeout(t);res2(m)});m.connect()});
 const created=await mux.call('session/create',{request:{cwd:path.join(ROOT,'workspace')}});
 const sid=unwrap(created).sessionId;
 const prompt=t=>mux.call('session/prompt',{request:{requestId:crypto.randomUUID(),sessionId:sid,mode:'queue',content:[{type:'text',text:t}]}});
 // 建一个任务
 await prompt('用 team_task_create 创建一个任务，subject 必须是 "cas-target"，不要别的动作。');
 const t1=await waitFor(async()=>{const t=await team(mux,sid);const x=(t&&t.tasks||[]).find(y=>String(y.subject).includes('cas-target'));return x||null},180000);
 if(!t1){console.log('RESULT: task creation not observed (cannot test CAS)');try{mux.close()}catch{};try{b.child.kill()}catch{};process.exit(0)}
 console.log('task created id=',t1.id,'revision=',t1.revision);
 // 让 Lead 先自增一次 revision（complete）
 await prompt(`用 team_task_update 把任务 ${t1.id} 标为 completed，expectedRevision 用 ${t1.revision}。`);
 const t2=await waitFor(async()=>{const t=await team(mux,sid);const x=(t&&t.tasks||[]).find(y=>y.id===t1.id);return x&&x.revision>t1.revision?x:null},180000);
 if(!t2){console.log('RESULT: first update not observed');try{mux.close()}catch{};try{b.child.kill()}catch{};process.exit(0)}
 console.log('after update revision=',t2.revision,'status=',t2.status);
 // 关键：用**过期** revision 再更新，应被拒绝
 const stale=t1.revision;
 await prompt(`现在再用 team_task_update 改任务 ${t1.id}，expectedRevision 用 ${stale}（这是过期的旧值），action 用 reopen。如果报错，把错误信息原样告诉我。`);
 await new Promise(r=>setTimeout(r,25000));
 const t3=await waitFor(async()=>{const t=await team(mux,sid);return (t&&t.tasks||[]).find(y=>y.id===t1.id)||null},60000);
 console.log('after stale-revision attempt revision=',t3&&t3.revision,'status=',t3&&t3.status);
 console.log(t3&&t3.revision===t2.revision ? 'RESULT: CAS ENFORCED (stale revision rejected, state unchanged)' : 'RESULT: CAS NOT ENFORCED (state changed despite stale revision)');
 try{mux.close()}catch{};try{b.child.kill()}catch{};process.exit(0);
})().catch(e=>{console.log('FATAL',e.message);process.exit(1)});
