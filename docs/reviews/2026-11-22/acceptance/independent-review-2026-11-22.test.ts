/** Independent acceptance probes. Failures reproduce review findings on 30408a6.
 * Synthetic in-memory databases only; does not touch the localhost review instance.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, Db, loadConfig, SandboxNotifier, seedDatabase, type Ctx } from '../src/index';
import { AgentRuntime, runAgent } from '../src/agents';
import { guardianHits, type GuardInput } from '../src/agents/guardian';
import { createStores, STORE_1, STORE_2 } from '../src/stores';
import { seedStore2 } from '../src/seed-store2';
import { confirmRecallLot, lookupRecall, quarantineRecalled } from '../src/recall';
import { transferPackages } from '../src/crossstore';
import { scanFill, sendBack, sell } from '../src/fill';
import { verifyAuditChain, type Actor } from '../src/core';
import { decide } from '../src/prescriber';

const NOW = Date.parse('2026-11-22T18:00:00Z');
const actor: Actor = {id:'u-rivera', name:'J. Rivera, PharmD', role:'pharmacist', storeId:STORE_1, workstation:'independent review'};
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function rig(two = false) {
  process.env.OFFLINE = '1';
  const cfg = loadConfig({}, {sqlitePath:':memory:', today:'2026-11-22', nightWatch:false, sandboxDelayMs:1, webDist:'/nonexistent', assetsDir:'/nonexistent'});
  const multi = two ? createStores(cfg) : null;
  const db = multi?.db ?? new Db(':memory:');
  const ctx: Ctx = {cfg, db, stores:multi?.reg, now:()=>NOW, notify:new SandboxNotifier(db,cfg), agents:new AgentRuntime({LLM_PROVIDER:'none'})};
  seedDatabase(multi ? multi.reg.db(STORE_1) : db, cfg, NOW);
  if (multi) seedStore2(multi.reg.db(STORE_2), NOW);
  cleanup.push(() => { if (multi) { for (const d of multi.reg.dbs.values()) d.raw.close(); } db.raw.close(); });
  return {ctx, db};
}
function recall(ctx: Ctx, lot: string, ndc: string, id = 'REVIEW-RECALL') {
  ctx.db.run("INSERT INTO recalls (id, status, step, source, created_at) VALUES (?, 'new', 'review', 'fax', ?)", id, NOW);
  ctx.db.run("INSERT INTO recall_lots (recall_id, lot, ndc11, confirmed_by, confirmed_at) VALUES (?,?,?,?,?)",id,lot,ndc,actor.name,NOW);
  quarantineRecalled(ctx,actor,id);
}

describe('Independent acceptance: clinical agent reads', () => {
  for (const who of ['m.diaz','s.grant']) for (const path of ['/api/agents/runs','/api/agents/rx-guardian']) {
    it(`${who} must not read clinical runs through ${path}`, async () => {
      const {ctx} = await rig();
      await runAgent(ctx,actor,'rx-guardian',{});
      const app = await buildApp(ctx); cleanup.push(()=>app.close());
      const login = await app.inject({method:'POST',url:'/api/auth/login',payload:{storeId:STORE_1,email:`${who}@elmstreetrx.example`,password:'moonlight-rx-2026'}});
      const cookie = login.cookies.map(c=>`${c.name}=${c.value}`).join('; ');
      const r = await app.inject({url:path,headers:{cookie}});
      expect(r.statusCode, 'clinical run records require a reader role check').toBe(403);
    });
  }
});

describe('Independent acceptance: history continuity', () => {
  for (const status of ['Active','Sold here']) it(`interaction rule includes current ${status} medicines`, () => {
    const input: GuardInput = {today:'2026-11-22',order:{rx:'T1',drug:'Ciprofloxacin 500 mg · 14 tab',ndc11:'',qty:1,directions:'Take 1 tablet twice daily for 7 days',days_supply:7,prescriber:'Dr. A'},product:null,patient:{id:'S-0001',dob:'1975-05-05',allergies:''},history:[{filled_on:'2026-11-20',ndc11:'',drug:'Insulin glargine 100 U/mL · 5 pens',sig:'Inject 20 units daily',qty:1,days_supply:68,status,lot:'TEST',prescriber:'Dr. A'}],lotBlocked:()=>null,priorFlags:{total:0,accepted:0}};
    expect(guardianHits(input).map(h=>h.rule)).toContain('interaction');
  });
});

describe('Independent acceptance: recall reads and store boundaries',()=>{
  for (const who of ['m.diaz','s.grant']) for (const url of ['/api/recalls','/api/recalls/D-0611-2026','/api/recalls/D-0611-2026/results']) {
    it(`${who} cannot read patient-linked recall data through ${url}`,async()=>{
      const {ctx}=await rig();
      await lookupRecall(ctx,actor,{number:'D-0611-2026'},{autoConfirm:true});
      const app=await buildApp(ctx); cleanup.push(()=>app.close());
      const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{storeId:STORE_1,email:`${who}@elmstreetrx.example`,password:'moonlight-rx-2026'}});
      const r=await app.inject({url,headers:{cookie:login.cookies.map(c=>`${c.name}=${c.value}`).join('; ')}});
      expect(r.statusCode,'patient-linked recall reads require explicit authorization').toBe(403);
    });
  }
  it('changing the store prefix cannot reuse a Store 7 session in Store 2',async()=>{
    const {ctx}=await rig(true); const app=await buildApp(ctx); cleanup.push(()=>app.close());
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{storeId:STORE_1,email:'j.rivera@elmstreetrx.example',password:'moonlight-rx-2026'}});
    const cookie=login.cookies.map(c=>`${c.name}=${c.value.replace('store-7','store-2')}`).join('; ');
    expect((await app.inject({url:'/api/me',headers:{cookie}})).statusCode).toBe(401);
  });
  it('Store 2 agent records never include Store 7 runs',async()=>{
    const {ctx}=await rig(true);
    await ctx.stores!.run(STORE_1,()=>runAgent(ctx,actor,'rx-guardian',{}));
    const app=await buildApp(ctx); cleanup.push(()=>app.close());
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{storeId:STORE_2,email:'s.okoro@birchavenuerx.example',password:'moonlight-rx-2026'}});
    const r=await app.inject({url:'/api/agents/runs',headers:{cookie:login.cookies.map(c=>`${c.name}=${c.value}`).join('; ')}});
    expect(r.statusCode).toBe(200); expect(r.json().runs).toEqual([]);
  });
});

describe('Independent acceptance: recall propagation', () => {
  for (const alreadyPresent of [false,true]) it(`mirrors a confirmed recall when destination pending row exists=${alreadyPresent}`, async () => {
    const {ctx} = await rig(true);
    if (alreadyPresent) await ctx.stores!.run(STORE_2,()=>lookupRecall(ctx,null,{number:'D-0611-2026'},{autoConfirm:false}));
    await ctx.stores!.run(STORE_1,()=>lookupRecall(ctx,actor,{number:'D-0611-2026'},{autoConfirm:true}));
    const r = ctx.stores!.run(STORE_2,()=>({
      confirmed:ctx.db.get<any>("SELECT confirmed_at FROM recall_lots WHERE recall_id='D-0611-2026' AND lot='GX4471C'")?.confirmed_at,
      shelf:ctx.db.get<any>("SELECT count(*) AS n FROM packages k JOIN lots l ON l.id=k.lot_id WHERE l.lot='GX4471C' AND k.status='on_shelf'")!.n
    }));
    expect(r.confirmed,'destination must upgrade its existing pending lot to confirmed').toBeTruthy();
    expect(r.shelf).toBe(0);
  });
  it('a repeat quarantine is idempotent',async()=>{
    const {ctx}=await rig();
    await lookupRecall(ctx,actor,{number:'D-0611-2026'},{autoConfirm:true});
    const before=ctx.db.get<any>("SELECT count(*) n FROM packages WHERE status='quarantined'")!.n;
    expect(quarantineRecalled(ctx,actor,'D-0611-2026')).toBe(0);
    expect(ctx.db.get<any>("SELECT count(*) n FROM packages WHERE status='quarantined'")!.n).toBe(before);
    expect(verifyAuditChain(ctx).ok).toBe(true);
  });
  it('a recalled fill waiting for pickup cannot be sold',async()=>{
    const {ctx,db}=await rig();
    const d=db.get<any>("SELECT d.id,l.lot,l.ndc11 FROM dispenses d JOIN packages k ON k.id=d.package_id JOIN lots l ON l.id=k.lot_id WHERE d.state='verified' LIMIT 1")!;
    expect(d).toBeTruthy(); recall(ctx,d.lot,d.ndc11);
    expect(()=>sell(ctx,actor,d.id,{idChecked:true,counseled:true,signature:true})).toThrow();
  });
  it('send-back never returns a recalled package to the shelf',async()=>{
    const {ctx,db}=await rig();
    const d=db.get<any>("SELECT d.id,d.package_id,l.lot,l.ndc11 FROM dispenses d JOIN packages k ON k.id=d.package_id JOIN lots l ON l.id=k.lot_id WHERE d.state='verified' LIMIT 1")!;
    recall(ctx,d.lot,d.ndc11);
    expect(()=>sendBack(ctx,actor,d.id,'independent review')).toThrow();
    expect(db.get<any>('SELECT status FROM packages WHERE id=?',d.package_id)?.status).toBe('quarantined');
  });
});

describe('Independent acceptance: interruption and human decisions',()=>{
  it('transfer failure cannot leave one serial on both stores shelves',async()=>{
    const {ctx}=await rig(true);
    const lot=ctx.db.get<any>("SELECT * FROM lots WHERE lot='AMX0626C'")!;
    const k=ctx.db.get<any>("SELECT * FROM packages WHERE lot_id=? AND status='on_shelf' ORDER BY id LIMIT 1",lot.id)!;
    // Simulate a disk/write failure at source after destination committed.
    ctx.stores!.db(STORE_1).raw.exec("CREATE TRIGGER review_write_failure BEFORE UPDATE ON packages WHEN NEW.status='adjusted' BEGIN SELECT RAISE(ABORT, 'review simulated write failure'); END");
    expect(()=>transferPackages(ctx,actor,{toStore:STORE_2,lotId:lot.id,qty:1})).toThrow(/simulated write failure/);
    const states=[STORE_1,STORE_2].map(id=>ctx.stores!.run(id,()=>ctx.db.get<any>('SELECT status FROM packages WHERE gtin=? AND serial=?',k.gtin,k.serial)?.status));
    expect(states.filter(s=>s==='on_shelf').length,JSON.stringify(states)).toBe(1);
  });
  it('a slow automatic review cannot overwrite a pharmacist hold',async()=>{
    const {ctx,db}=await rig();
    let release!:(s:string)=>void; let entered!:()=>void;
    const reached=new Promise<void>(r=>entered=r);
    ctx.llm={name:'review-barrier',complete:async()=>{entered();return new Promise<string>(r=>release=r);}};
    db.run("UPDATE prescriptions SET review='none' WHERE rx='0072214'");
    const pending=scanFill(ctx,actor,'0072214',{fields:{ndc:'70004-803-90',lot:'AT24K118',expiry:'2028-01-31'},source:'typed'}).then(()=> 'filled', e=>`blocked:${e.code}`);
    await reached;
    // Use the same pharmacist decision service as the HTTP endpoint.
    decide(ctx,actor,'0072214',{action:'change',message:'Please review this order before filling.'});
    expect(db.get<any>("SELECT review FROM prescriptions WHERE rx='0072214'")!.review).toBe('on_hold');
    release('{}');
    const outcome=await pending;
    expect(db.get<any>("SELECT review FROM prescriptions WHERE rx='0072214'")!.review,outcome).toBe('on_hold');
    expect(outcome).not.toBe('filled');
  });
});
