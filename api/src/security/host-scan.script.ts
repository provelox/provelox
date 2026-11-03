/**
 * Run by `node -e` in a short-lived, read-only helper container that has the host's whole filesystem at /host (read
 * only) and the host's process view. It looks for the usual signs of a machine someone else controls and prints one
 * line of JSON: raw facts only. Deciding what they mean is `host-findings.ts`, which is tested on its own.
 *
 * The helper runs in its OWN container filesystem, with its own libraries. That matters: the common rootkit puts a
 * library in the host's /etc/ld.so.preload so every program on the host lies about files and processes. Nothing here
 * loads that file, and it only reads the host's files as data, so the lie does not reach this script.
 *
 * What it never reads: a process's command line, a key's secret part (only the public blob, to make a fingerprint),
 * or the content of any file not named below. It changes nothing.
 *
 * The roots can be moved for a test (PVX_HOST, PVX_PROC, PVX_SAMPLE_MS); in the helper they are not set.
 * The text has no backticks and no dollar-brace, so it can sit in a String.raw template.
 */
export const HOST_SCAN_SCRIPT = String.raw`
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const H=process.env.PVX_HOST||'/host',P=process.env.PVX_PROC||'/proc';
const SAMPLE=Number(process.env.PVX_SAMPLE_MS||1000);
const T=(f,max)=>{try{const b=fs.readFileSync(f);return (max&&b.length>max?b.subarray(b.length-max):b).toString('utf8')}catch{return null}};
const LS=(d)=>{try{return fs.readdirSync(d)}catch{return[]}};
const ST=(f)=>{try{return fs.statSync(f)}catch{return null}};
const out={};
// 1. A library forced into every program on the host
{const t=T(H+'/etc/ld.so.preload');
 if(t===null)out.preload=null;
 else{const e=t.split(/[\s:]+/).filter((x)=>x&&x[0]!=='#').slice(0,5);
  out.preload={size:t.length,entries:e.map((p)=>{const s=ST(H+p);return{path:p.slice(0,120),exists:!!s,size:s?s.size:0}})}}}
// 2. A second account with root's user id
out.uid0=(T(H+'/etc/passwd')||'').split('\n').map((l)=>l.split(':')).filter((f)=>f[2]==='0'&&f[0]!=='root').map((f)=>f[0].slice(0,32)).slice(0,5);
// 3. Processes the kernel lists in a control group but /proc does not show, and ones running from odd places
{const live=new Set(LS(P).filter((x)=>/^[0-9]+$/.test(x)));
 const cg=new Set();let seen=0;
 const walk=(d,depth)=>{if(depth>6||seen>6000)return;seen++;
  const t=T(d+'/cgroup.procs');if(t)for(const x of t.split('\n'))if(x)cg.add(x);
  for(const n of LS(d)){const s=ST(d+'/'+n);if(s&&s.isDirectory())walk(d+'/'+n,depth+1)}};
 walk(H+'/sys/fs/cgroup',0);
 let only=0;for(const x of cg)if(!live.has(x)&&!fs.existsSync(P+'/'+x))only++;
 out.cgroupOnly=only;
 const odd=[];const oddC=[];
 for(const pid of live){let exe='';try{exe=fs.readlinkSync(P+'/'+pid+'/exe')}catch{continue}
  if(!exe)continue;
  // The path is as the process itself sees it, so for a container it is a path inside that container
  const cg=(T(P+'/'+pid+'/cgroup')||'').match(/[0-9a-f]{64}/);
  const del=/ \(deleted\)$/.test(exe),tmp=/^\/(tmp|var\/tmp|dev\/shm)\//.test(exe);
  const dot=/\/\.[^\/.][^\/]*\//.test(exe)&&!/\/\.(vscode-server|nvm|cargo|rustup|pyenv|sdkman|bun|deno|volta)\//.test(exe);
  const nm=()=>(T(P+'/'+pid+'/comm')||'').trim().slice(0,32);
  // A dot folder is where a container's own tools live (~/.cache, ~/.local): only on the machine itself is it a sign
  if(cg){if(del||tmp)oddC.push({name:nm(),exe:exe.slice(0,120),c:cg[0].slice(0,12)})}
  else if(del||tmp||dot)odd.push({name:nm(),exe:exe.slice(0,120)})}
 out.oddProcs=odd.slice(0,8);out.oddProcCount=odd.length;
 out.oddCtrProcs=oddC.slice(0,8);out.oddCtrProcCount=oddC.length}
// 4. Scheduled jobs that run something from a hidden or temporary place
{const files=[];
 const add=(d)=>{for(const n of LS(d)){const f=d+'/'+n;const s=ST(f);if(s&&s.isFile())files.push(f)}};
 add(H+'/var/spool/cron/crontabs');add(H+'/var/spool/cron');add(H+'/etc/cron.d');
 for(const w of ['hourly','daily','weekly','monthly'])add(H+'/etc/cron.'+w);
 files.push(H+'/etc/crontab');
 const KNOWN=/perfcc|perfclean|libgcwrap|kdevtmpfsi|kinsing|xmrig|minerd|cryptonight/i;
 const ODD=/(^|[\s;&|])(\/tmp|\/var\/tmp|\/dev\/shm)\/|\/\.[A-Za-z0-9_][^\s\/]*\/|(curl|wget)[^|]*\|\s*(ba)?sh/;
 const hits=[];
 for(const f of files){const rel=f.slice(H.length);
  if(KNOWN.test(path.basename(f)))hits.push({file:rel.slice(0,80),line:'(the file is named for known malware)',known:true});
  const t=T(f,20000);if(!t)continue;
  for(const raw of t.split('\n')){const l=raw.trim();if(!l||l[0]==='#')continue;
   const k=KNOWN.test(l);if(k||ODD.test(l))hits.push({file:rel.slice(0,80),line:l.slice(0,120),known:k})}}
 out.cron=hits.slice(0,10)}
// 5. Programs left in the places anyone can write to
{const elf=[];
 const look=(d,depth)=>{for(const n of LS(d)){if(elf.length>=10)return;const f=d+'/'+n;let s;try{s=fs.lstatSync(f)}catch{continue}
  if(s.isDirectory()){if(depth<2)look(f,depth+1);continue}
  if(!s.isFile()||!(s.mode&0o111))continue;
  try{const fd=fs.openSync(f,'r');const b=Buffer.alloc(4);fs.readSync(fd,b,0,4,0);fs.closeSync(fd);
   if(b[0]===0x7f&&b[1]===0x45&&b[2]===0x4c&&b[3]===0x46)elf.push(f.slice(H.length).slice(0,120))}catch{}}};
 for(const d of ['/tmp','/dev/shm','/var/tmp'])look(H+d,0);
 out.elf=elf}
// 6. How people may sign in over SSH (the first line to say so wins, and the .d files come first)
{const parts=LS(H+'/etc/ssh/sshd_config.d').filter((n)=>n.endsWith('.conf')).sort().map((n)=>T(H+'/etc/ssh/sshd_config.d/'+n)||'');
 parts.push(T(H+'/etc/ssh/sshd_config')||'');
 const first=(key)=>{for(const p of parts)for(const raw of p.split('\n')){const m=raw.trim().match(new RegExp('^'+key+'\\s+(\\S+)','i'));if(m)return m[1].toLowerCase()}return null};
 out.sshd={password:first('PasswordAuthentication'),rootLogin:first('PermitRootLogin')}}
// 7. Which keys may sign in as root: fingerprints and comments, never the keys
{const f=H+'/root/.ssh/authorized_keys';const t=T(f);const s=ST(f);
 if(t===null)out.keys=null;
 else{const list=[];
  for(const raw of t.split('\n')){const l=raw.trim();if(!l||l[0]==='#')continue;
   const w=l.split(/\s+/);const i=w.findIndex((x)=>/^(ssh-|ecdsa-|sk-)/.test(x));
   if(i<0||!w[i+1])continue;
   let fp='';try{fp='SHA256:'+crypto.createHash('sha256').update(Buffer.from(w[i+1],'base64')).digest('base64').replace(/=+$/,'')}catch{}
   list.push({type:w[i].slice(0,24),fp,comment:w.slice(i+2).join(' ').slice(0,40)})}
  out.keys={ageDays:s?Math.round(((Date.now()-s.mtimeMs)/86400000)*10)/10:null,list:list.slice(0,12)}}}
// 8. Failed sign-ins over the last day
{const t=T(H+'/var/log/auth.log',6*1024*1024)||T(H+'/var/log/secure',6*1024*1024);
 if(t===null)out.auth=null;
 else{const now=Date.now(),cut=now-86400000;let n=0;const ips=new Map();
  const MON={Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  for(const l of t.split('\n')){
   if(!/Failed password|Invalid user|authentication failure/.test(l))continue;
   let at=NaN;const iso=l.match(/^(\d{4}-\d\d-\d\dT[\d:.]+)(Z|[+-]\d\d:\d\d)?/);
   if(iso)at=Date.parse(iso[1]+(iso[2]||'Z'));
   else{const m=l.match(/^([A-Z][a-z]{2})\s+(\d+)\s+(\d\d):(\d\d):(\d\d)/);
    if(m){const d=new Date();let x=Date.UTC(d.getUTCFullYear(),MON[m[1]],Number(m[2]),Number(m[3]),Number(m[4]),Number(m[5]));if(x>now+86400000)x=Date.UTC(d.getUTCFullYear()-1,MON[m[1]],Number(m[2]),Number(m[3]),Number(m[4]),Number(m[5]));at=x}}
   if(!(at>=cut))continue;
   n++;const ip=l.match(/(?:from|rhost=)\s*([0-9a-fA-F.:]+)/);if(ip)ips.set(ip[1],(ips.get(ip[1])||0)+1)}
  out.auth={failed24h:n,top:[...ips.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3)}}}
// 9. Docker's own API open on the network
{let tcp=false,tls=false;
 const dj=T(H+'/etc/docker/daemon.json');
 if(dj){try{const j=JSON.parse(dj);if(Array.isArray(j.hosts)&&j.hosts.some((h)=>/^tcp:/.test(String(h))))tcp=true;if(j.tlsverify||j.tls)tls=true}catch{}}
 const units=[H+'/lib/systemd/system/docker.service',H+'/usr/lib/systemd/system/docker.service'];
 for(const n of LS(H+'/etc/systemd/system/docker.service.d'))units.push(H+'/etc/systemd/system/docker.service.d/'+n);
 units.push(H+'/etc/systemd/system/docker.service');
 for(const u of units){const t=T(u,50000);if(!t)continue;
  for(const l of t.split('\n'))if(/^\s*ExecStart/.test(l)){if(/-H[= ]*tcp:\/\//.test(l))tcp=true;if(/--tls(verify)?\b/.test(l))tls=true}}
 out.dockerTcp=tcp&&!tls}
// 10. Anything outside a container working hard, sampled over a moment
{const snap=()=>{const m=new Map();for(const p of LS(P))if(/^[0-9]+$/.test(p)){const s=T(P+'/'+p+'/stat');if(!s)continue;const i=s.lastIndexOf(')');if(i<0)continue;const f=s.slice(i+2).split(' ');m.set(p,Number(f[11])+Number(f[12]))}return m};
 const a=snap();const t0=Date.now();
 setTimeout(()=>{const b=snap();const dt=(Date.now()-t0)/1000||1;const top=[];
  for(const [p,t] of b){const cpu=Math.max(0,t-(a.has(p)?a.get(p):t))/100/dt*100;if(cpu<60)continue;
   const cg=T(P+'/'+p+'/cgroup')||'';if(/docker|containerd|kubepods/.test(cg))continue;
   const nm=(T(P+'/'+p+'/comm')||'').trim().slice(0,32);if(!nm)continue;
   top.push({name:nm,cpu:Math.round(cpu)})}
  out.hostBusy=top.sort((x,y)=>y.cpu-x.cpu).slice(0,5);
  console.log(JSON.stringify(out))},SAMPLE)}
`;
