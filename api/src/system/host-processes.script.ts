/**
 * Run by `node -e` in a short-lived helper that shares the host's process view. It reads /proc twice, a second apart,
 * and prints one line of JSON: the busiest process names by processor and by memory, summed per name and container.
 * Only the name (comm) is read, never the command line, which can hold a password.
 *
 * CPU is the change in user plus system ticks (100 a second on Linux) over the time between the two readings, in
 * percent of one core. Memory is VmRSS. The container id comes from the process's cgroup path.
 */
export const HOST_PROCESSES_SCRIPT = `
const fs=require('fs');
const R=(f)=>{try{return fs.readFileSync(f,'utf8')}catch{return ''}};
const snap=()=>{const m=new Map();for(const p of fs.readdirSync('/proc'))if(/^[0-9]+$/.test(p)){const s=R('/proc/'+p+'/stat');const i=s.lastIndexOf(')');if(i<0)continue;const f=s.slice(i+2).split(' ');m.set(p,Number(f[11])+Number(f[12]))}return m};
const a=snap();const t0=process.hrtime.bigint();
setTimeout(()=>{
const b=snap();const dt=Number(process.hrtime.bigint()-t0)/1e9;const g=new Map();
for(const [p,t] of b){
if(p===String(process.pid))continue;
const name=R('/proc/'+p+'/comm').trim();if(!name)continue;
const cg=R('/proc/'+p+'/cgroup').match(/[0-9a-f]{64}/);const cid=cg?cg[0].slice(0,12):'';
const mm=R('/proc/'+p+'/status').match(/^VmRSS:\\s+([0-9]+) kB/m);
const cpu=Math.max(0,t-(a.has(p)?a.get(p):t))/100/dt*100;
const k=name+'|'+cid;const e=g.get(k)||{n:name,c:cid,k:0,u:0,m:0};
e.k++;e.u+=cpu;e.m+=mm?Number(mm[1])*1024:0;g.set(k,e)}
const all=[...g.values()].map((e)=>({n:e.n,c:e.c,k:e.k,u:Math.round(e.u*10)/10,m:e.m}));
const pick=(f)=>[...all].filter((e)=>e[f]>0).sort((x,y)=>y[f]-x[f]).slice(0,15);
const out=new Map();for(const e of [...pick('u'),...pick('m')])out.set(e.n+'|'+e.c,e);
console.log(JSON.stringify({dt:Math.round(dt*100)/100,top:[...out.values()]}));
},1000);
`;
