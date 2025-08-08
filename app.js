// Overdr1ve — Browser Prototype (refactored)
// Random 5 tracks, type-gated track bonus, upgrade conditions,
// single-use upgrades, manual-pick priority, CP/ML breakdown,
// end modal + confetti + charts (finish rate, avg CP by player), highlight "You".

const POINTS = [25,18,15,12,10,8,6,4];

// ---------- DOM utils ----------
function $(sel){ return document.querySelector(sel); }
function el(tag, cls){ const e=document.createElement(tag); if(cls) e.className=cls; return e; }

// ---------- CSV helpers ----------
async function fetchCSV(path){
  const res = await fetch(path);
  if(!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return parseCSV(await res.text());
}
function parseCSV(text){
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map(s=>s.trim());
  const rows = [];
  for(let i=1;i<lines.length;i++){
    if(!lines[i].trim()) continue;
    const parts = splitCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h,idx)=> obj[h] = (parts[idx] ?? "").trim());
    rows.push(obj);
  }
  return rows;
}
function splitCSVLine(line){
  const out=[]; let cur=""; let inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){ if(inQ && line[i+1]==='"'){cur+='"'; i++;} else inQ=!inQ; }
    else if(ch==="," && !inQ){ out.push(cur); cur=""; }
    else cur+=ch;
  }
  out.push(cur);
  return out;
}
function toInt(v,f=0){ const n=parseInt(String(v).replace(/[^\d-]/g,""),10); return isNaN(n)?f:n; }
function parseTrackBonus(s){
  if(!s || !s.trim()) return {field:null, amount:0};
  const m = s.match(/(-?\d+)\s*(Core Power|Max Laps)/i);
  if(!m) return {field:null, amount:0};
  return {field:m[2], amount:toInt(m[1])};
}

// ---------- Condition helpers ----------
const CONDITION_KEYS = ["Track Type Condition","Condition","TrackType Condition","TrackTypeCondition"];
function getUpgConditionRaw(upg){
  for(const k of CONDITION_KEYS){
    if(Object.prototype.hasOwnProperty.call(upg,k)){
      const v=(upg[k]||"").trim();
      if(v) return v;
    }
  }
  return ""; // => Any
}
function norm(s){ return (s||"").toLowerCase().trim(); }
function tokens(raw){
  const m = norm(raw);
  const set = new Set();
  if(!m || m==="-" || m==="any"){ set.add("any"); return Array.from(set); }
  if(m.includes("sun") || m.includes("☀")) set.add("sunny");
  if(m.includes("night") || m.includes("🌙")) set.add("night");
  if(m.includes("rain") || m.includes("☔")) set.add("rainy");
  if(m.includes("twist") || m.includes("🌀")) set.add("twisty");
  m.split(/[\/,|+ ]+/).forEach(tok=>{
    const t=norm(tok);
    if(["sunny","night","rainy","twisty"].includes(t)) set.add(t);
  });
  return set.size ? Array.from(set) : ["any"];
}
function conditionLabel(upg){
  const raw = getUpgConditionRaw(upg);
  return raw ? raw : "Any";
}
function isUpgradeActiveOnTrack(upg, trackType){
  const want = tokens(getUpgConditionRaw(upg));
  const on = tokens(trackType);
  if(want.includes("any")) return true;
  return want.some(w => on.includes(w));
}
function typesMatch(a, b){
  const A = tokens(a), B = tokens(b);
  return A.some(t => B.includes(t)); // overlap means match
}

// ---------- Utils ----------
function shuffle(arr){ const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.random()*(i+1)|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }
function pickRandom(arr, n){ return shuffle(arr).slice(0, Math.min(n, arr.length)); }

// ---------- Core calc ----------
function computeEffective(car, track, upgrade){
  const baseCP = toInt(car["Core Power"]);
  const baseML = toInt(car["Max Laps"]);
  const tb = parseTrackBonus(track["Type Bonus"]||"");

  let cp=baseCP, ml=baseML;
  let trackCP=0, trackML=0, upgCP=0, upgML=0;
  let upgName="-", upgApplied=false, cond="-", condActive=false;

  // Track bonus only if car type matches track type
  if(typesMatch(car["Track Type"], track["Track Type"])){
    if(tb.field==="Core Power"){ cp+=tb.amount; trackCP=tb.amount; }
    if(tb.field==="Max Laps"){   ml+=tb.amount; trackML=tb.amount; }
  }

  if(upgrade){
    cond = conditionLabel(upgrade);
    condActive = isUpgradeActiveOnTrack(upgrade, track["Track Type"]);
    if(condActive){
      upgCP = toInt(upgrade["Core Power"]);
      upgML = toInt(upgrade["Max Laps"]);
      cp += upgCP; ml += upgML;
      upgApplied = true;
    }
    upgName = upgrade["Upgrade"];
  }

  const totalLaps = toInt(track["Total Laps"]);
  const dnf = ml < totalLaps;
  return { cp, ml, dnf, upgName, upgApplied, baseCP, baseML, trackCP, trackML, upgCP, upgML, cond, condActive };
}

// ---------- Greedy pick (respects single-use) ----------
function pickBestUpgradeGreedy(car, track, upgrades, usedSet){
  let best = { upg: null, eff: computeEffective(car, track, null), key: 0 };
  best.key = (best.eff.dnf?0:1)*10_000_000 + best.eff.cp*10_000 + best.eff.ml;

  for(const upg of upgrades){
    if(usedSet && usedSet.has(upg["Upgrade"])) continue;
    const eff = computeEffective(car, track, upg);
    const key = (eff.dnf?0:1)*10_000_000 + eff.cp*10_000 + eff.ml;
    if(!best || key > best.key) best = { upg, eff, key };
  }
  return best.upg; // can be null
}

// ---------- UI helpers ----------
function renderCardKV(kv){
  const box = el("div","kv");
  for(const [k,v] of kv){
    const kd=el("div"); kd.innerHTML=`<span class="muted">${k}</span>`;
    const vd=el("div"); vd.textContent=v;
    box.appendChild(kd); box.appendChild(vd);
  }
  return box;
}
function renderTrackCard(track){
  const wrap = el("div");
  const b = parseTrackBonus(track["Type Bonus"]);
  const badges = el("div");
  badges.innerHTML = `
    <span class="badge">Type: ${track["Track Type"]}</span>
    <span class="badge">Total Laps: ${track["Total Laps"]}</span>
    <span class="badge">Bonus: ${b.amount} ${b.field ?? "-"}</span>`;
  wrap.appendChild(badges);
  wrap.appendChild(renderCardKV([
    ["Name", track["Track"]],
    ["Track Type", track["Track Type"]],
    ["Total Laps", track["Total Laps"]],
    ["Type Bonus", track["Type Bonus"] || "-"],
  ]));
  return wrap;
}
function renderCarCard(car){
  const wrap = el("div");
  const badges = el("div");
  badges.innerHTML = `<span class="badge">${car["Car"]}</span><span class="badge">Type: ${car["Track Type"]}</span>`;
  wrap.appendChild(badges);
  wrap.appendChild(renderCardKV([
    ["Core Power", car["Core Power"]],
    ["Max Laps", car["Max Laps"]],
  ]));
  return wrap;
}

// table helper: allow row meta {cells:[], rowClass:""}
function table(headers, rows){
  const tbl=el("table");
  const thead=el("thead");
  const tr=el("tr");
  headers.forEach(h=>{ const th=el("th"); th.textContent=h; tr.appendChild(th); });
  thead.appendChild(tr); tbl.appendChild(thead);

  const tbody=el("tbody");
  rows.forEach(r=>{
    const meta = Array.isArray(r) ? {cells:r} : r;
    const tr=el("tr");
    if(meta.rowClass) tr.classList.add(meta.rowClass);
    meta.cells.forEach(c=>{
      const td=el("td");
      if(c && c.el) td.appendChild(c.el); else td.textContent=(c??"");
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  return tbl;
}
function badge(text, extra=""){ const s=el("span","badge "+extra); s.textContent=text; return s; }

// ---------- Game State ----------
const state = {
  cars: [],
  allTracks: [],
  tracks: [],
  upgrades: [],
  players: [], // { id,name,isHuman,car,points,wins,finishes,usedUpgrades:Set }
  currentTrackIndex: 0,
  resultsByTrack: [],
  started: false,
};

// ---------- Load data ----------
async function loadData(){
  const cars     = await fetchCSV("./data_csv/cars.csv");
  const tracks   = await fetchCSV("./data_csv/tracks.csv");
  const upgrades = await fetchCSV("./data_csv/upgrades.csv");

  for(const c of cars){ c["Core Power"]=toInt(c["Core Power"]); c["Max Laps"]=toInt(c["Max Laps"]); }
  for(const t of tracks){ t["Total Laps"]=toInt(t["Total Laps"]); }
  for(const u of upgrades){ u["Core Power"]=toInt(u["Core Power"]); u["Max Laps"]=toInt(u["Max Laps"]); }

  state.cars = cars;
  state.allTracks = tracks;         // keep all tracks; choose later
  state.upgrades = upgrades;

  // Dev helpers if you open console
  window._dbgUpgrades = upgrades;
  window._dbgAllTracks = tracks;
}

// ---------- Setup UI ----------
function initSetupUI(){
  const carSel=$("#carSelect");
  carSel.innerHTML="";
  state.cars.forEach((c,idx)=>{
    const opt=el("option");
    opt.value=String(idx);
    opt.textContent=`${c["Car"]} — CP ${c["Core Power"]}, ML ${c["Max Laps"]} (${c["Track Type"]})`;
    carSel.appendChild(opt);
  });

  $("#startBtn").onclick=()=>{
    const idx=parseInt($("#carSelect").value,10)||0;
    startRace(idx);
  };
}

// ---------- Start race (random 5 tracks) ----------
function startRace(playerCarIndex){
  state.tracks = pickRandom(state.allTracks, 5);
  const pool=[...state.cars];
  const playerCar=pool[playerCarIndex];
  pool.splice(playerCarIndex,1);
  // const botCars=pool.slice(0,7);
  const botCars = pool.slice(0, Math.min(7, pool.length));

  state.players=[
    {id:1,name:"You",isHuman:true,car:playerCar,points:0,wins:0,finishes:0,usedUpgrades:new Set()},
    ...botCars.map((c,i)=>({id:i+2,name:`Bot ${i+1}`,isHuman:false,car:c,points:0,wins:0,finishes:0,usedUpgrades:new Set()}))
  ];
  state.currentTrackIndex=0;
  state.resultsByTrack=[];
  state.started=true;

  $("#setupSection").classList.add("hidden");
  $("#raceSection").classList.remove("hidden");
  renderRaceUI();
}

// ---------- Race UI ----------
function renderRaceUI(){
  const track = state.tracks[state.currentTrackIndex];
  $("#trackCard").innerHTML=""; $("#trackCard").appendChild(renderTrackCard(track));

  const player = state.players.find(p=>p.isHuman);
  $("#playerCard").innerHTML=""; $("#playerCard").appendChild(renderCarCard(player.car));

  const upSel=$("#upgradeSelect"); upSel.innerHTML="";
  const none=el("option"); none.value="-1"; none.textContent="(No upgrade)"; upSel.appendChild(none);

  state.upgrades.forEach((u,idx)=>{
    if(player.usedUpgrades.has(u["Upgrade"])) return; // single-use
    const opt=el("option");
    opt.value=String(idx);
    opt.textContent=`${u["Upgrade"]} — +CP ${u["Core Power"]}, +ML ${u["Max Laps"]} [${conditionLabel(u)}]`;
    upSel.appendChild(opt);
  });

  $("#useGreedyPickBtn").onclick=()=>{
    const best=pickBestUpgradeGreedy(player.car, track, state.upgrades, player.usedUpgrades);
    if(!best){ upSel.value="-1"; return; }
    const idx=state.upgrades.findIndex(u=>u["Upgrade"]===best["Upgrade"]);
    upSel.value=(idx>=0 && !player.usedUpgrades.has(best["Upgrade"])) ? String(idx) : "-1";
  };

  $("#simulateTrackBtn").onclick=()=>simulateTrack();
  $("#simulateAllBtn").onclick=()=>simulateAll();
  $("#resetBtn").onclick=()=>resetGame();

  renderStandings();
}

// ---------- Simulate one track ----------
function simulateTrack(){
  const track = state.tracks[state.currentTrackIndex];
  const player = state.players.find(p=>p.isHuman);
  const autoPick = $("#autoPickTrack")?.checked;

  let selectedIdx = parseInt($("#upgradeSelect").value,10);
  if(Number.isNaN(selectedIdx)) selectedIdx = -1;

  let playerUpgrade = null;
  if(selectedIdx >= 0){
    playerUpgrade = state.upgrades[selectedIdx];
    if(player.usedUpgrades.has(playerUpgrade["Upgrade"])) playerUpgrade=null; // safety
  } else if(autoPick){
    playerUpgrade = pickBestUpgradeGreedy(player.car, track, state.upgrades, player.usedUpgrades);
  }

  const decisions=[];
  for(const p of state.players){
    let upg=null;
    if(p.isHuman) upg = playerUpgrade;
    else upg = pickBestUpgradeGreedy(p.car, track, state.upgrades, p.usedUpgrades);
    decisions.push({pid:p.id, upgrade:upg});
  }

  const results = state.players.map(p=>{
    const picked = decisions.find(d=>d.pid===p.id)?.upgrade || null;
    const eff = computeEffective(p.car, track, picked);
    return { id:p.id, name:p.name, isHuman:p.isHuman, car:p.car["Car"],
      effCP:eff.cp, effML:eff.ml, dnf:eff.dnf, upgrade:eff.upgName,
      upgApplied:eff.upgApplied, cond:eff.cond, condActive:eff.condActive, br:eff };
  });

  const finishers = results
    .filter(r => !r.dnf)
    .sort((a, b) =>
      (b.effCP - a.effCP) ||
      (b.effML - a.effML) ||
      (a.id - b.id)
    );
  const dnfs = results
    .filter(r => r.dnf)
    .sort((a, b) =>
      (b.effCP - a.effCP) ||
      (b.effML - a.effML) ||
      (a.id - b.id)
    );
  // const dnfs = results.filter(r=>r.dnf).sort((a,b)=>b.effCP-a.effCP);
  const ranked = [...finishers, ...dnfs];

  ranked.forEach((r,i)=>{
    const pl = state.players.find(p=>p.id===r.id);
    const pts = r.dnf ? 0 : (POINTS[i] ?? 0);
    pl.points += pts;
    if(!r.dnf) pl.finishes += 1;
  });
  if(finishers.length){
    const wid = finishers[0].id;
    const w = state.players.find(p=>p.id===wid);
    if(w) w.wins += 1;
  }

  // Mark used upgrades (single-use) even if inactive (you chose it)
  for(const d of decisions){
    if(d.upgrade){
      const pl = state.players.find(p=>p.id===d.pid);
      pl.usedUpgrades.add(d.upgrade["Upgrade"]);
    }
  }

  state.resultsByTrack.push({track, ranked});
  renderTrackResults(ranked, track);
  renderStandings();

  state.currentTrackIndex += 1;
  if(state.currentTrackIndex >= state.tracks.length){
    $("#simulateTrackBtn").disabled=true;
    $("#useGreedyPickBtn").disabled=true;
    $("#upgradeSelect").disabled=true;
    $("#simulateAllBtn").disabled=true;
    setTimeout(showEndOfRaceModal, 700); // small delay feels better
  } else {
    renderRaceUI();
  }
}

// ---------- Simulate all ----------
async function simulateAll(){
  while(state.currentTrackIndex < state.tracks.length){
    simulateTrack();
    await new Promise(r=>setTimeout(r,120));
  }
}

// ---------- Results + standings ----------
function renderTrackResults(ranked, track){
  const host=$("#trackResults"); host.innerHTML="";
  const rows = ranked.map((r,i)=>{
    const pos=i+1;
    const status = r.dnf ? {el:badge("DNF","dnf")} : {el:badge("Finished","ok")};
    const applied = r.upgApplied ? "✓" : "—";

    const cpSpan = el("span");
    cpSpan.textContent = r.effCP;
    cpSpan.title = `CP = Base ${r.br.baseCP} + Track ${r.br.trackCP} + Upgrade ${r.br.upgCP}`;

    const mlSpan = el("span");
    mlSpan.textContent = r.effML;
    mlSpan.title = `ML = Base ${r.br.baseML} + Track ${r.br.trackML} + Upgrade ${r.br.upgML}`;

    const condSpan = el("span");
    condSpan.textContent = r.cond;
    condSpan.title = r.condActive ? "Condition active" : "Condition NOT active";

    return {
      rowClass: r.isHuman ? "you-row" : "",
      cells: [pos, r.name+(r.isHuman?" (You)":"") , r.car, {el:cpSpan}, {el:mlSpan},
              status, r.upgrade||"-", {el:condSpan}, applied, r.dnf?0:(POINTS[i]??0)]
    };
  });

  const tbl = table(
    ["Pos","Player","Car","Eff. CP","Eff. ML","Status","Upgrade","Condition","Upg OK?","Points"],
    rows
  );

  const title = el("div");
  title.innerHTML = `<div class="row"><strong>Track:</strong> ${track["Track"]}
    &nbsp; <span class="badge">Type: ${track["Track Type"]}</span>
    <span class="badge">Laps: ${track["Total Laps"]}</span>
    <span class="badge">Bonus: ${track["Type Bonus"]||"-"}</span></div>`;

  host.appendChild(title);
  host.appendChild(tbl);
}

function renderStandings(){
  const host=$("#standings"); host.innerHTML="";
  // const ordered=[...state.players].sort((a,b)=>b.points-a.points);
  const ordered = [...state.players].sort((a, b) =>
    (b.points - a.points) ||
    (b.wins - a.wins) ||
    (b.finishes - a.finishes) ||
    (a.id - b.id)
  );
  const rows=ordered.map((p,i)=>({
    rowClass: p.isHuman ? "you-row" : "",
    cells: [ i+1, p.name+(p.isHuman?" (You)":"") , p.car["Car"], p.points, p.wins, `${p.finishes}/${state.resultsByTrack.length}` ]
  }));
  host.appendChild(table(["Rank","Player","Car","Points","Wins","Finishes"], rows));
}

function resetGame(){
  state.players=[]; state.currentTrackIndex=0; state.resultsByTrack=[]; state.started=false;
  $("#raceSection").classList.add("hidden"); $("#setupSection").classList.remove("hidden");
  $("#simulateTrackBtn").disabled=false; $("#useGreedyPickBtn").disabled=false;
  $("#upgradeSelect").disabled=false; $("#simulateAllBtn").disabled=false;
  initSetupUI();
}

// ---------- Mini chart: simple horizontal bars ----------
function renderBarChart(hostId, labels, values, {suffix="", max=null}={}){
  const host = document.getElementById(hostId);
  host.innerHTML = "";
  const wrap = el("div","barwrap");
  const maxVal = max ?? Math.max(...values, 1);
  labels.forEach((lab, i) => {
    const row = el("div","barrow");
    const labEl = el("span","barlabel"); labEl.textContent = lab;
    const bar = el("div","bar");
    const fill = el("div","barfill");
    fill.style.width = `${(values[i] / maxVal) * 100}%`;
    fill.title = `${values[i]}${suffix}`;
    bar.appendChild(fill);
    const val = el("span","barvalue"); val.textContent = `${values[i]}${suffix}`;
    row.appendChild(labEl); row.appendChild(bar); row.appendChild(val);
    wrap.appendChild(row);
  });
  host.appendChild(wrap);
}

// ---------- Confetti ----------
function launchConfetti(durationMs=2500, count=160){
  const canvas = document.getElementById("confetti");
  const ctx = canvas.getContext("2d");
  const DPR = window.devicePixelRatio || 1;
  function resize(){ canvas.width = innerWidth*DPR; canvas.height = innerHeight*DPR; canvas.style.display="block"; }
  resize(); window.addEventListener("resize", resize, {once:true});

  const parts = Array.from({length:count}, () => ({
    x: Math.random()*canvas.width,
    y: -Math.random()*canvas.height*0.5,
    r: 2 + Math.random()*3,
    vx: (Math.random()-0.5)*1.5*DPR,
    vy: (2 + Math.random()*2.5)*DPR,
    color: `hsl(${Math.random()*360},100%,60%)`,
    alpha: 1
  }));
  const t0 = performance.now();
  function tick(t){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    parts.forEach(p=>{
      p.vy += 0.02*DPR; p.x += p.vx; p.y += p.vy;
      ctx.globalAlpha = p.alpha; ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI*2); ctx.fill();
    });
    if (t - t0 < durationMs) requestAnimationFrame(tick);
    else { canvas.style.display="none"; }
  }
  requestAnimationFrame(tick);
}

// ---------- End-of-race modal ----------
function showEndOfRaceModal(){
  const modal = document.getElementById("endModal");
  const closeBtn = document.getElementById("closeEndModal");
  const lb = document.getElementById("finalLeaderboard");
  lb.innerHTML = "";

  // Leaderboard (with highlight)
  // const ordered = [...state.players].sort((a,b)=>b.points-a.points);
  const ordered = [...state.players].sort((a, b) =>
    (b.points - a.points) ||
    (b.wins - a.wins) ||
    (b.finishes - a.finishes) ||
    (a.id - b.id)
  );
  const rows = ordered.map((p,i)=>({
    rowClass: p.isHuman ? "you-row" : "",
    cells: [ i+1,
             p.name + (p.isHuman ? " (You)" : ""),
             p.car["Car"],
             p.points,
             p.wins,
             `${p.finishes}/${state.tracks.length}` ]
  }));
  lb.appendChild(table(["Rank","Player","Car","Points","Wins","Finishes"], rows));

  // Finish rate per player
  renderBarChart(
    "chartFinishRate",
    ordered.map(p=>p.name + (p.isHuman?"*":"")),
    ordered.map(p=> Math.round((p.finishes/state.tracks.length)*100)),
    { suffix:"%", max:100 }
  );

  // Average Effective CP by Player (ordered to match leaderboard)
  const cpAgg = new Map(); // id -> {sum,count}
  state.resultsByTrack.forEach(rt=>{
    rt.ranked.forEach(r=>{
      const cur = cpAgg.get(r.id) || {sum:0, count:0};
      cur.sum += r.effCP; cur.count += 1;
      cpAgg.set(r.id, cur);
    });
  });
  const labelsP = ordered.map(p => p.name + (p.isHuman ? "*" : ""));
  const cpAvgP  = ordered.map(p => {
    const a = cpAgg.get(p.id) || {sum:0,count:1};
    return Math.round(a.sum / a.count);
  });
  renderBarChart("chartCPByTrack", labelsP, cpAvgP, {});

  // Open modal + confetti
  modal.classList.add("open");
  closeBtn.onclick = () => modal.classList.remove("open");
  document.addEventListener("keydown", escCloseOnce, {once:true});
  launchConfetti();
}
function escCloseOnce(e){
  if(e.key === "Escape"){
    document.getElementById("endModal")?.classList.remove("open");
  }
}

// ---------- boot ----------
(async function main(){
  try { await loadData(); }
  catch (e){
    alert("Failed to load CSVs. Ensure ./data_csv/cars.csv, ./data_csv/tracks.csv, ./data_csv/upgrades.csv exist.\n\n"+e.message);
    throw e;
  }
  initSetupUI();
})();
