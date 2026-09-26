// DO NOT DELETE: Cloudflare Workers Free plan ima CPU limit od 10ms po invokaciji.
// CPU vreme = vreme koje procesor provede IZVRŠAVAJUĆI naš JS kod (petlje, string obrada, JSON).
// Fetch i D1 upiti NE troše CPU — oni su čekanje.
// Pravila:
//   - Izbegavati velike petlje i spajanje stringova u petlji (binary += char)
//   - btoa() nad velikim fajlovima je skupo — koristiti chunked pristup (vidi arrayBufferToBase64)
//   - Wall time limit za cron je 15 min (free), ali CPU od 10ms je pravi problem
//   - Svi pozadinski poslovi koriste GLOBALNI lock ('global') — nikad dva teška posla paralelno
//   - Subrequest limit na Free planu je 50 po invokaciji — poslovi koji petljaju moraju da broje i prekinu pre 45
//   - Svi fetch ka GitHub API-ju MORAJU imati 'User-Agent' header
//   - Svi fetch ka eksternim servisima MORAJU proći kroz fetchSaRateLimit (1s po servisu)
//   - Svi uspešni pozivi ka eksternim servisima MORAJU se evidentirati u servisi (održivost)
//   - kripto_kes koristi UPSERT + COALESCE (merge umesto replace)
//   - Uparivanje: 4 kruga (CG slug, CMC slug, CP/CS sa crticom, simbol+2% cena)
//   - Ako cena nedostupna, prihvati na osnovu sluga (bez verifikacije)
//   - Parametri imena: jedinica u nazivu (npr. _sek, _min, _dana)
//   - zabeleziUpit prima tip i brojElemenata: 'pojedinacni' | 'bulk' | 'batch'
//   - Reset perioda po UTC 0 — prvi upit u novom periodu resetuje brojače (utroseno = 1)
//   - Bulk se naplaćuje po batch_max: ceil(brojElemenata / bulk_max) * cena_bulk
//   - /upit ruta: striktno po servisu, bez auto-odabira, bez keša

// ===== MODULE-SCOPE STATE =====
let kriptoMetaKeš = null, kriptoMetaKešVreme = 0;
let servisiKeš = null, servisiKešVreme = 0;
let parametriKeš = null, parametriKešVreme = 0;
let cgMarketsKeš = null, cgMarketsKešVreme = 0;
let csListaKeš = null, csListaKešVreme = 0;
let cpTickeriKeš = null, cpTickeriKešVreme = 0;
const uToku = {};
const zadnjiPoziv = {};

// ===== POMOĆNE =====
function normalizuj(s) { if (!s) return ''; return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }

function levenshtein(a, b) {
  if (!a || !b) return 999;
  const m = a.length, n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return dp[m][n];
}

function slicnost(a, b) { if (!a || !b) return 0; const maxLen = Math.max(a.length, b.length); return maxLen === 0 ? 1 : 1 - (levenshtein(a, b) / maxLen); }

function cenaBlizu(c1, c2, tolerancija = 0.02) {
  if (c1 == null || c2 == null) return false;
  if (c1 === 0 && c2 === 0) return true;
  const max = Math.max(Math.abs(c1), Math.abs(c2));
  if (max === 0) return true;
  return Math.abs(c1 - c2) / max <= tolerancija;
}

function procRazlika(c1, c2) {
  if (c1 == null || c2 == null || c1 === 0) return null;
  return Math.abs((c1 - c2) / c1) * 100;
}

function zaokruziCenu(c) {
  if (c == null || !isFinite(c)) return null;
  const aps = Math.abs(c);
  let dec;
  if (aps >= 1000) dec = 2;
  else if (aps >= 10) dec = 3;
  else if (aps >= 1) dec = 4;
  else if (aps >= 0.01) dec = 6;
  else if (aps >= 0.0001) dec = 8;
  else if (aps >= 0.000001) dec = 10;
  else dec = 12;
  return parseFloat(c.toFixed(dec));
}

function zaokruziVolumen(v) {
  if (v == null || !isFinite(v)) return null;
  const aps = Math.abs(v);
  if (aps >= 1e9) return Math.round(v / 1e7) * 1e7;
  if (aps >= 1e6) return Math.round(v / 1e4) * 1e4;
  if (aps >= 1e3) return Math.round(v / 100) * 100;
  if (aps >= 1) return Math.round(v);
  return parseFloat(v.toFixed(2));
}

function zaokruziProcenat(p) {
  if (p == null || !isFinite(p)) return null;
  return parseFloat(p.toFixed(2));
}

async function cekajUToku(naziv, maxMs = 3000) {
  let cekano = 0;
  while (uToku[naziv] && cekano < maxMs) { await new Promise(r => setTimeout(r, 100)); cekano += 100; }
  return !uToku[naziv];
}

async function rateLimit(servis) {
  const sada = Date.now();
  const zadnji = zadnjiPoziv[servis] || 0;
  const minRazmak = (servis === 'coinstats') ? 2000 : 1000;
  const razmak = sada - zadnji;
  if (razmak < minRazmak) {
    await new Promise(r => setTimeout(r, minRazmak - razmak));
  }
  zadnjiPoziv[servis] = Date.now();
}

async function fetchSaRateLimit(url, options = {}, servis = null) {
  if (!servis) {
    if (url.includes('coinmarketcap.com')) servis = 'cmc';
    else if (url.includes('coingecko.com')) servis = 'coingecko';
    else if (url.includes('coinstats.app')) servis = 'coinstats';
    else if (url.includes('coinpaprika.com')) servis = 'coinpaprika';
    else if (url.includes('etherscan.io')) servis = 'etherscan';
    else if (url.includes('blockscout.com')) servis = 'blockscout';
    else if (url.includes('allratestoday.com')) servis = 'nbs';
    else servis = 'other';
  }
  await rateLimit(servis);
  return fetch(url, options);
}

// ===== PERIODI (UTC 0 reset) =====
function nadjiKrajPeriodaUTC(period, sada) {
  const d = new Date(sada);
  if (period === 'dan') {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function periodMs(period, periodKraj) {
  if (period === 'dan') return 86400000;
  const d = new Date(periodKraj);
  const m = d.getUTCMonth();
  const y = d.getUTCFullYear();
  const prethodniMesec = m === 0 ? 11 : m - 1;
  const prethodnaGodina = m === 0 ? y - 1 : y;
  const daysInMonth = new Date(Date.UTC(prethodnaGodina, prethodniMesec + 1, 0)).getUTCDate();
  return daysInMonth * 86400000;
}

function izracunajOdrzivost(utroseno, limit, periodKraj, period) {
  if (!utroseno || utroseno === 0) return null;
  if (!limit || limit === 0) return null;
  if (!periodKraj) return null;
  const sada = Date.now();
  const pms = periodMs(period, periodKraj);
  const pocetak = periodKraj - pms;
  const proteklo = Math.min(Math.max(sada - pocetak, 0), pms);
  const utrosenoProcenat = utroseno / limit;
  if (utrosenoProcenat === 0) return null;
  return (proteklo / pms) / utrosenoProcenat;
}

function getBelgradeVreme() {
  const sada = new Date();
  const delovi = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Belgrade', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(sada);
  let hh = 0, mm = 0;
  for (const p of delovi) { if (p.type === 'hour') hh = parseInt(p.value, 10); if (p.type === 'minute') mm = parseInt(p.value, 10); }
  return { hh, mm };
}

function getUTCVremeCrtice() {
  const sada = new Date();
  const hh = String(sada.getUTCHours()).padStart(2, '0');
  const mm = String(sada.getUTCMinutes()).padStart(2, '0');
  return `${hh}-${mm}`;
}

// ===== LOCK =====
const LOCK_MRTAV_MS = 60000;

async function uzmiLock(env, posao, workerId) {
  const sada = Date.now(); const mrtav = sada - LOCK_MRTAV_MS;
  try {
    await env.DB.prepare("INSERT INTO poslovi_lock (posao, worker_id, heartbeat) VALUES (?, ?, ?)").bind(posao, workerId, sada).run();
    return true;
  } catch (e) {
    try {
      const r = await env.DB.prepare("UPDATE poslovi_lock SET worker_id = ?, heartbeat = ? WHERE posao = ? AND heartbeat < ?").bind(workerId, sada, posao, mrtav).run();
      return r.meta && r.meta.changes > 0;
    } catch (e2) { return false; }
  }
}

async function osveziHeartbeat(env, posao, workerId) {
  try { await env.DB.prepare("UPDATE poslovi_lock SET heartbeat = ? WHERE posao = ? AND worker_id = ?").bind(Date.now(), posao, workerId).run(); } catch (e) {}
}

async function pustiLock(env, posao, workerId) {
  try { await env.DB.prepare("DELETE FROM poslovi_lock WHERE posao = ? AND worker_id = ?").bind(posao, workerId).run(); } catch (e) {}
}

function noviWorkerId() { return 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

async function saGlobalLock(env, ime, fn) {
  const p0 = Date.now();
  const workerId = noviWorkerId();
  let lockUzet = false;
  try {
    lockUzet = await uzmiLock(env, 'global', workerId);
    if (!lockUzet) { await logCron(env, ime, 'ok', 'preskoceno — lock aktivan', Date.now() - p0); return; }
    const rez = await fn(env, workerId, p0);
    return rez;
  } catch (e) {
    await logCron(env, ime, 'greska', e.message, Date.now() - p0);
  } finally {
    if (lockUzet) await pustiLock(env, 'global', workerId);
  }
}

// ===== CHECKPOINT =====
async function zapisiCheckpoint(env, posao, podaci) {
  try { await env.DB.prepare("INSERT OR REPLACE INTO kes (servis, kljuc, podaci, vreme) VALUES ('checkpoint', ?, ?, ?)").bind(posao, JSON.stringify(podaci), Date.now()).run(); } catch (e) {}
}
async function citajCheckpoint(env, posao) {
  try { const r = await env.DB.prepare("SELECT podaci, vreme FROM kes WHERE servis='checkpoint' AND kljuc=?").bind(posao).first(); if (!r) return null; return { ...JSON.parse(r.podaci), vreme: r.vreme }; } catch (e) { return null; }
}
async function obrisiCheckpoint(env, posao) {
  try { await env.DB.prepare("DELETE FROM kes WHERE servis='checkpoint' AND kljuc=?").bind(posao).run(); } catch (e) {}
}

// ===== PARAMETRI =====
async function getParametri(env) {
  if (parametriKeš && (Date.now() - parametriKešVreme) < 60000) return parametriKeš;
  try {
    const rows = await env.DB.prepare("SELECT kljuc, vrednost FROM parametri").all();
    const p = {};
    for (const r of rows.results) p[r.kljuc] = r.vrednost;
    parametriKeš = p; parametriKešVreme = Date.now();
    return p;
  } catch (e) { return parametriKeš || {}; }
}

async function ttlZaToken(env, simbol, maxOdrzivost) {
  const p = await getParametri(env);
  const base = parseInt(p['ttl_kripto_sek'] || '600', 10) * 1000;
  if (maxOdrzivost === null || maxOdrzivost === undefined) return base;
  if (maxOdrzivost > 1.50) return base;
  if (maxOdrzivost > 1.25) return base * 1.25;
  if (maxOdrzivost > 1.00) return base * 1.50;
  if (maxOdrzivost > 0.75) return base * 1.75;
  if (maxOdrzivost > 0.50) return base * 2.00;
  return base * 3.00;
}

// ===== LOG =====
async function logCron(env, tip, status, poruka, trajanje) {
  try { await env.DB.prepare("INSERT INTO cron_log (vreme, tip, status, poruka, trajanje_ms) VALUES (?, ?, ?, ?, ?)").bind(Date.now(), tip, status, poruka, trajanje).run(); } catch (e) {}
}

// ===== KRAJ DEO 1/7 =====

// ===== GITHUB =====
async function gitHubUpload(env, putanja, sadrzaj) {
  const token = env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: 'GITHUB_TOKEN nema' };
  const url = `https://api.github.com/repos/DenMartinCom/sajt-u-izradi/contents/${putanja}`;
  const headers = { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'KriptoWorker/1.0' };
  try {
    let sha = null;
    const getRes = await fetch(url, { headers });
    if (getRes.ok) { const d = await getRes.json(); sha = d.sha; }
    const body = { message: `Upload ${putanja}`, content: btoa(unescape(encodeURIComponent(sadrzaj))) };
    if (sha) body.sha = sha;
    const putRes = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: putRes.ok, status: putRes.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function gitHubUploadSigurno(env, putanja, base64, message) {
  const token = env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: 'GITHUB_TOKEN nema' };
  const url = `https://api.github.com/repos/DenMartinCom/sajt-u-izradi/contents/${putanja}`;
  const headers = { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'KriptoWorker/1.0' };
  try {
    let sha = null;
    const getRes = await fetch(url, { headers });
    if (getRes.ok) { const d = await getRes.json(); sha = d.sha; }
    const body = { message, content: base64 };
    if (sha) body.sha = sha;
    let putRes = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (putRes.status === 409) {
      const getRes2 = await fetch(url, { headers });
      if (getRes2.ok) { const d2 = await getRes2.json(); body.sha = d2.sha; putRes = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    }
    return { ok: putRes.ok, status: putRes.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function getGitHubFajl(env, putanja) {
  const token = env.GITHUB_TOKEN;
  const url = `https://api.github.com/repos/DenMartinCom/sajt-u-izradi/contents/${putanja}`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'KriptoWorker/1.0' } });
    if (res.status === 200) return { postoji: true };
    return { postoji: false, status: res.status };
  } catch (e) { return { postoji: false, error: e.message }; }
}

async function getGitHubFajlSaSadrzajem(env, putanja) {
  const token = env.GITHUB_TOKEN;
  const url = `https://api.github.com/repos/DenMartinCom/sajt-u-izradi/contents/${putanja}`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'KriptoWorker/1.0' } });
    if (!res.ok) return { postoji: false, status: res.status };
    const d = await res.json();
    let sadrzaj = null;
    if (d.content) {
      try {
        sadrzaj = JSON.parse(decodeURIComponent(escape(atob(d.content.replace(/\n/g, '')))));
      } catch (e) { sadrzaj = null; }
    }
    return { postoji: true, sha: d.sha, sadrzaj };
  } catch (e) { return { postoji: false, error: e.message }; }
}

async function getGitHubFolderListSve(env, putanja) {
  const token = env.GITHUB_TOKEN;
  if (!token) return [];
  const sve = [];
  for (let page = 1; page <= 20; page++) {
    const url = `https://api.github.com/repos/DenMartinCom/sajt-u-izradi/contents/${putanja}?per_page=100&page=${page}`;
    try {
      const res = await fetch(url, { headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'KriptoWorker/1.0' } });
      if (!res.ok) break;
      const d = await res.json();
      if (!Array.isArray(d) || !d.length) break;
      sve.push(...d);
      if (d.length < 100) break;
    } catch (e) { break; }
  }
  return sve;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < len; i += chunk) { binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)); }
  return btoa(binary);
}

async function uploadFileOnGitHub(env, sourceUrl, putanja, message, extraHeaders = {}) {
  if (!sourceUrl || !putanja) return { ok: false, error: 'nedostaje url ili putanja' };
  try {
    const res = await fetch(sourceUrl, { headers: { 'User-Agent': 'Kripto/1.0', ...extraHeaders } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buffer = await res.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    return await gitHubUploadSigurno(env, putanja, base64, message || `Upload ${putanja}`);
  } catch (e) { return { ok: false, error: e.message }; }
}

// ===== SERVISI =====
async function getServisi(env) {
  if (servisiKeš && (Date.now() - servisiKešVreme) < 60000) return servisiKeš;
  try {
    const rows = await env.DB.prepare("SELECT * FROM servisi").all();
    const s = {};
    for (const r of rows.results) s[r.naziv] = r;
    servisiKeš = s; servisiKešVreme = Date.now();
    return s;
  } catch (e) { return servisiKeš || {}; }
}

// ===== ZABELEZI UPIT (POPRAVLJENO: dodat blok za cenu) =====
async function zabeleziUpit(env, naziv, tip, brojElemenata = 1) {
  try {
    const svi = await getServisi(env);
    const s = svi[naziv];
    if (!s) return;

    const sada = Date.now();
    let utroseno = s.utroseno_kredita || 0;
    let periodKraj = s.period_kraj;

    if (!periodKraj || sada >= periodKraj) {
      utroseno = 1;
      periodKraj = nadjiKrajPeriodaUTC(s.period, sada);
    }

    let cena = 0;
    if (tip === 'bulk' && s.bulk_max > 0 && s.cena_bulk > 0) {
      const brojBulkova = Math.ceil(brojElemenata / s.bulk_max);
      cena = brojBulkova * s.cena_bulk;
    } else if (tip === 'batch' && s.cena_batch > 0) {
      cena = s.cena_batch;
    } else {
      cena = s.cena_pojedinacni || 0;
    }

    utroseno += cena;
    const preostalo = Math.max(0, (s.limit_kredita || 0) - utroseno);
    const odrzivost = izracunajOdrzivost(utroseno, s.limit_kredita, periodKraj, s.period);

    await env.DB.prepare("UPDATE servisi SET utroseno_kredita=?, preostalo_kredita=?, period_kraj=?, odrzivost=?, zadnja_greska=NULL, zadnja_greska_tip=NULL WHERE naziv=?")
      .bind(utroseno, preostalo, periodKraj, odrzivost, naziv).run();
    servisiKešVreme = 0;
  } catch (e) {}
}

async function zabeleziGresku(env, naziv, tip) {
  try { await env.DB.prepare("UPDATE servisi SET zadnja_greska=?, zadnja_greska_tip=? WHERE naziv=?").bind(Date.now(), String(tip), naziv).run(); servisiKešVreme = 0; } catch (e) {}
}

async function getServisiSortirani(env) {
  const svi = await getServisi(env);
  const sada = Date.now();
  const lista = [];
  for (const [naziv, s] of Object.entries(svi)) {
    if (!s.aktivan) continue;
    if (s.zadnja_greska && (sada - s.zadnja_greska) < (s.cooldown_sek || 120) * 1000) continue;

    let utroseno = s.utroseno_kredita || 0;
    let periodKraj = s.period_kraj;

    if (!periodKraj || sada >= periodKraj) {
      utroseno = 1;
      periodKraj = nadjiKrajPeriodaUTC(s.period, sada);
    }

    const odrzivost = izracunajOdrzivost(utroseno, s.limit_kredita, periodKraj, s.period);
    lista.push({ ...s, odrzivost, utroseno_kredita: utroseno, period_kraj: periodKraj });
  }
  lista.sort((a, b) => {
    const va = (a.odrzivost === null || a.odrzivost === undefined) ? 999 : a.odrzivost;
    const vb = (b.odrzivost === null || b.odrzivost === undefined) ? 999 : b.odrzivost;
    return vb - va;
  });
  return lista;
}

// ===== KRIPTO META =====
async function getKriptoMeta(env) {
  if (kriptoMetaKeš && (Date.now() - kriptoMetaKešVreme) < 60000) return kriptoMetaKeš;
  try {
    const rows = await env.DB.prepare("SELECT simbol, naziv, coingecko_id, cmc_id, cmc_slug, coinstats_id, coinpaprika_id, cryptorank_id, contract, decimals, je_stablecoin, logo_lokalno, description, website, explorer, rank FROM kripto_meta WHERE propali = 0").all();
    const meta = {};
    for (const r of rows.results) {
      meta[r.simbol] = { naziv: r.naziv, coingecko: r.coingecko_id, cmc: r.cmc_id, cmc_slug: r.cmc_slug, coinstats: r.coinstats_id, coinpaprika: r.coinpaprika_id, cryptorank: r.cryptorank_id, contract: r.contract, decimals: r.decimals, je_stablecoin: r.je_stablecoin, logo_lokalno: r.logo_lokalno, description: r.description, website: r.website, explorer: r.explorer, rank: r.rank };
    }
    kriptoMetaKeš = meta; kriptoMetaKešVreme = Date.now();
    return meta;
  } catch (e) { return kriptoMetaKeš || {}; }
}

function nadjiSimbolPoContract(meta, c) { if (!c) return null; const cl = c.toLowerCase(); for (const [s, i] of Object.entries(meta)) if (i.contract && i.contract.toLowerCase() === cl) return s; return null; }
function nadjiSimbolPoCgId(meta, id) { for (const [s, i] of Object.entries(meta)) if (i.coingecko === id) return s; return null; }
function nadjiSimbolPoCpId(meta, id) { for (const [s, i] of Object.entries(meta)) if (i.coinpaprika === id) return s; return null; }
function nadjiSimbolPoCmcuId(meta, id) { for (const [s, i] of Object.entries(meta)) if (String(i.cmc) === String(id)) return s; return null; }
function nadjiSimbolPoCsId(meta, id) { for (const [s, i] of Object.entries(meta)) if (i.coinstats === id) return s; return null; }
function nadjiSimbolPoCrId(meta, id) { for (const [s, i] of Object.entries(meta)) if (String(i.cryptorank) === String(id)) return s; return null; }

// ===== KRAJ DEO 2/7 =====

// ===== CENE =====
async function getCenaIzD1(env, simbol, ttl) {
  try {
    const row = await env.DB.prepare("SELECT cena, vreme FROM kripto_kes WHERE token=?").bind(simbol).first();
    if (!row) return null;
    if ((Date.now() - row.vreme) < ttl) return { cena: row.cena, vreme: row.vreme };
    return null;
  } catch (e) { return null; }
}

function crCena(v) {
  if (v == null) return null;
  const n = parseFloat(v);
  return isFinite(n) && n > 0 ? n : null;
}

// ===== UPSERT sa COALESCE =====
async function upisiCeneBulk(env, prices, izvor) {
  if (!prices || !prices.length) return;
  const sada = Date.now();
  const izv = izvor || 'nepoznat';
  for (const p of prices) {
    if (!p.cena || isNaN(p.cena)) continue;
    const token = p.simbol;
    try {
      await env.DB.prepare(`
        INSERT INTO kripto_kes (
          token, cena, vreme, izvor, rank,
          volumen_24h, market_cap,
          pr_cena_15m, pr_cena_30m, pr_cena_1h, pr_cena_6h, pr_cena_12h,
          pr_cena_24h, pr_cena_7d, pr_cena_14d, pr_cena_30d, pr_cena_60d,
          pr_cena_90d, pr_cena_200d, pr_cena_1y,
          pr_vol_15m, pr_vol_30m, pr_vol_1h, pr_vol_6h, pr_vol_12h,
          pr_vol_24h, pr_vol_7d, pr_vol_14d, pr_vol_30d, pr_vol_60d,
          pr_vol_90d, pr_vol_200d, pr_vol_1y
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET
          cena = EXCLUDED.cena, vreme = EXCLUDED.vreme, izvor = EXCLUDED.izvor,
          rank = COALESCE(EXCLUDED.rank, kripto_kes.rank),
          volumen_24h = COALESCE(EXCLUDED.volumen_24h, kripto_kes.volumen_24h),
          market_cap = COALESCE(EXCLUDED.market_cap, kripto_kes.market_cap),
          pr_cena_15m = COALESCE(EXCLUDED.pr_cena_15m, kripto_kes.pr_cena_15m),
          pr_cena_30m = COALESCE(EXCLUDED.pr_cena_30m, kripto_kes.pr_cena_30m),
          pr_cena_1h = COALESCE(EXCLUDED.pr_cena_1h, kripto_kes.pr_cena_1h),
          pr_cena_6h = COALESCE(EXCLUDED.pr_cena_6h, kripto_kes.pr_cena_6h),
          pr_cena_12h = COALESCE(EXCLUDED.pr_cena_12h, kripto_kes.pr_cena_12h),
          pr_cena_24h = COALESCE(EXCLUDED.pr_cena_24h, kripto_kes.pr_cena_24h),
          pr_cena_7d = COALESCE(EXCLUDED.pr_cena_7d, kripto_kes.pr_cena_7d),
          pr_cena_14d = COALESCE(EXCLUDED.pr_cena_14d, kripto_kes.pr_cena_14d),
          pr_cena_30d = COALESCE(EXCLUDED.pr_cena_30d, kripto_kes.pr_cena_30d),
          pr_cena_60d = COALESCE(EXCLUDED.pr_cena_60d, kripto_kes.pr_cena_60d),
          pr_cena_90d = COALESCE(EXCLUDED.pr_cena_90d, kripto_kes.pr_cena_90d),
          pr_cena_200d = COALESCE(EXCLUDED.pr_cena_200d, kripto_kes.pr_cena_200d),
          pr_cena_1y = COALESCE(EXCLUDED.pr_cena_1y, kripto_kes.pr_cena_1y),
          pr_vol_15m = COALESCE(EXCLUDED.pr_vol_15m, kripto_kes.pr_vol_15m),
          pr_vol_30m = COALESCE(EXCLUDED.pr_vol_30m, kripto_kes.pr_vol_30m),
          pr_vol_1h = COALESCE(EXCLUDED.pr_vol_1h, kripto_kes.pr_vol_1h),
          pr_vol_6h = COALESCE(EXCLUDED.pr_vol_6h, kripto_kes.pr_vol_6h),
          pr_vol_12h = COALESCE(EXCLUDED.pr_vol_12h, kripto_kes.pr_vol_12h),
          pr_vol_24h = COALESCE(EXCLUDED.pr_vol_24h, kripto_kes.pr_vol_24h),
          pr_vol_7d = COALESCE(EXCLUDED.pr_vol_7d, kripto_kes.pr_vol_7d),
          pr_vol_14d = COALESCE(EXCLUDED.pr_vol_14d, kripto_kes.pr_vol_14d),
          pr_vol_30d = COALESCE(EXCLUDED.pr_vol_30d, kripto_kes.pr_vol_30d),
          pr_vol_60d = COALESCE(EXCLUDED.pr_vol_60d, kripto_kes.pr_vol_60d),
          pr_vol_90d = COALESCE(EXCLUDED.pr_vol_90d, kripto_kes.pr_vol_90d),
          pr_vol_200d = COALESCE(EXCLUDED.pr_vol_200d, kripto_kes.pr_vol_200d),
          pr_vol_1y = COALESCE(EXCLUDED.pr_vol_1y, kripto_kes.pr_vol_1y)
      `).bind(
        token, p.cena, sada, izv, p.rank ?? null,
        p.volumen_24h ?? null, p.market_cap ?? null,
        p.pr_cena_15m ?? null, p.pr_cena_30m ?? null, p.pr_cena_1h ?? null, p.pr_cena_6h ?? null, p.pr_cena_12h ?? null,
        p.pr_cena_24h ?? null, p.pr_cena_7d ?? null, p.pr_cena_14d ?? null, p.pr_cena_30d ?? null, p.pr_cena_60d ?? null,
        p.pr_cena_90d ?? null, p.pr_cena_200d ?? null, p.pr_cena_1y ?? null,
        p.pr_vol_15m ?? null, p.pr_vol_30m ?? null, p.pr_vol_1h ?? null, p.pr_vol_6h ?? null, p.pr_vol_12h ?? null,
        p.pr_vol_24h ?? null, p.pr_vol_7d ?? null, p.pr_vol_14d ?? null, p.pr_vol_30d ?? null, p.pr_vol_60d ?? null,
        p.pr_vol_90d ?? null, p.pr_vol_200d ?? null, p.pr_vol_1y ?? null
      ).run();
    } catch (e) { console.warn(`upisiCeneBulk ${token}:`, e.message); }
  }
}

// ===== MAPIRANJE =====
function mapirajCMC(q, rank) {
  const p = {};
  if (rank != null) p.rank = rank;
  if (q.volume_24h != null) p.volumen_24h = parseFloat(q.volume_24h);
  if (q.market_cap != null) p.market_cap = parseFloat(q.market_cap);
  if (q.percent_change_1h != null) p.pr_cena_1h = parseFloat(q.percent_change_1h);
  if (q.percent_change_24h != null) p.pr_cena_24h = parseFloat(q.percent_change_24h);
  if (q.percent_change_7d != null) p.pr_cena_7d = parseFloat(q.percent_change_7d);
  if (q.percent_change_30d != null) p.pr_cena_30d = parseFloat(q.percent_change_30d);
  if (q.percent_change_60d != null) p.pr_cena_60d = parseFloat(q.percent_change_60d);
  if (q.percent_change_90d != null) p.pr_cena_90d = parseFloat(q.percent_change_90d);
  if (q.volume_change_24h != null) p.pr_vol_24h = parseFloat(q.volume_change_24h);
  return p;
}

function mapirajCG(c) {
  const p = {};
  if (c.total_volume != null) p.volumen_24h = parseFloat(c.total_volume);
  if (c.market_cap != null) p.market_cap = parseFloat(c.market_cap);
  if (c.market_cap_rank != null) p.rank = c.market_cap_rank;
  if (c.price_change_percentage_1h_in_currency != null) p.pr_cena_1h = parseFloat(c.price_change_percentage_1h_in_currency);
  if (c.price_change_percentage_24h_in_currency != null) p.pr_cena_24h = parseFloat(c.price_change_percentage_24h_in_currency);
  if (c.price_change_percentage_7d_in_currency != null) p.pr_cena_7d = parseFloat(c.price_change_percentage_7d_in_currency);
  if (c.price_change_percentage_14d_in_currency != null) p.pr_cena_14d = parseFloat(c.price_change_percentage_14d_in_currency);
  if (c.price_change_percentage_30d_in_currency != null) p.pr_cena_30d = parseFloat(c.price_change_percentage_30d_in_currency);
  if (c.price_change_percentage_200d_in_currency != null) p.pr_cena_200d = parseFloat(c.price_change_percentage_200d_in_currency);
  if (c.price_change_percentage_1y_in_currency != null) p.pr_cena_1y = parseFloat(c.price_change_percentage_1y_in_currency);
  return p;
}

function mapirajCS(c) {
  const p = {};
  if (c.volume != null) p.volumen_24h = parseFloat(c.volume);
  if (c.marketCap != null) p.market_cap = parseFloat(c.marketCap);
  if (c.rank != null) p.rank = c.rank;
  if (c.priceChange1h != null) p.pr_cena_1h = parseFloat(c.priceChange1h);
  if (c.priceChange1d != null) p.pr_cena_24h = parseFloat(c.priceChange1d);
  if (c.priceChange1w != null) p.pr_cena_7d = parseFloat(c.priceChange1w);
  if (c.priceChange1m != null) p.pr_cena_30d = parseFloat(c.priceChange1m);
  return p;
}

function mapirajCP(q, rank) {
  const p = {};
  if (rank != null) p.rank = rank;
  if (q.volume_24h != null) p.volumen_24h = parseFloat(q.volume_24h);
  if (q.volume_24h_change_24h != null) p.pr_vol_24h = parseFloat(q.volume_24h_change_24h);
  if (q.market_cap != null) p.market_cap = parseFloat(q.market_cap);
  if (q.percent_change_15m != null) p.pr_cena_15m = parseFloat(q.percent_change_15m);
  if (q.percent_change_30m != null) p.pr_cena_30m = parseFloat(q.percent_change_30m);
  if (q.percent_change_1h != null) p.pr_cena_1h = parseFloat(q.percent_change_1h);
  if (q.percent_change_6h != null) p.pr_cena_6h = parseFloat(q.percent_change_6h);
  if (q.percent_change_12h != null) p.pr_cena_12h = parseFloat(q.percent_change_12h);
  if (q.percent_change_24h != null) p.pr_cena_24h = parseFloat(q.percent_change_24h);
  if (q.percent_change_7d != null) p.pr_cena_7d = parseFloat(q.percent_change_7d);
  if (q.percent_change_30d != null && q.percent_change_30d !== 0) p.pr_cena_30d = parseFloat(q.percent_change_30d);
  if (q.percent_change_1y != null && q.percent_change_1y !== 0) p.pr_cena_1y = parseFloat(q.percent_change_1y);
  return p;
}

// ===== UPARIVANJE (4 kruga) =====
function upariPoSlugICeni(metaToken, kandidat, cenaToken, cenaKandidat, krug) {
  const cgId = normalizuj(metaToken.coingecko || '');
  const cmcSlug = normalizuj(metaToken.cmc_slug || '');

  const kIdRaw = String(kandidat.id || '');
  const kIdDelovi = kIdRaw.split('-').map(p => normalizuj(p)).filter(p => p);
  const kSlugN = normalizuj(kandidat.slug || '');
  const kSimbolN = normalizuj(kandidat.symbol || '');

  const sviDelovi = new Set([...kIdDelovi, kSlugN].filter(x => x));

  let slugMatch = false;
  if (krug === 1) {
    slugMatch = cgId && (cgId === normalizuj(kIdRaw) || cgId === kSlugN);
  } else if (krug === 2) {
    slugMatch = cmcSlug && (cmcSlug === normalizuj(kIdRaw) || cmcSlug === kSlugN);
  } else if (krug === 3) {
    slugMatch = (cgId && sviDelovi.has(cgId)) || (cmcSlug && sviDelovi.has(cmcSlug));
  } else if (krug === 4) {
    slugMatch = kSimbolN === normalizuj(metaToken.simbol);
  }

  if (!slugMatch) return { nadjeno: false };

  const imaCene = cenaToken != null && cenaKandidat != null;
  if (imaCene) {
    return { nadjeno: true, auto: cenaBlizu(cenaToken, cenaKandidat, 0.02), kandidat, krug };
  }
  if (krug === 4) return { nadjeno: true, auto: false, kandidat, krug };
  return { nadjeno: true, auto: true, kandidat, krug };
}

// ===== POLJA — problematična (ne daju ih svi servisi) =====
const POLJA_PROBLEMATICNA = {
  cmc: ['pr_cena_60d', 'pr_cena_90d', 'pr_vol_24h'],
  cg:  ['pr_cena_14d', 'pr_cena_200d', 'pr_cena_1y'],
  cs:  [],
  cp:  ['pr_cena_15m', 'pr_cena_30m', 'pr_cena_6h', 'pr_cena_12h', 'pr_cena_1y', 'pr_vol_24h'],
  cr:  []
};

const SVA_POLJA = [
  'pr_cena_15m', 'pr_cena_30m', 'pr_cena_1h', 'pr_cena_6h', 'pr_cena_12h', 'pr_cena_24h',
  'pr_cena_7d', 'pr_cena_14d', 'pr_cena_30d', 'pr_cena_60d', 'pr_cena_90d', 'pr_cena_200d', 'pr_cena_1y',
  'pr_vol_15m', 'pr_vol_30m', 'pr_vol_1h', 'pr_vol_6h', 'pr_vol_12h', 'pr_vol_24h',
  'pr_vol_7d', 'pr_vol_14d', 'pr_vol_30d', 'pr_vol_60d', 'pr_vol_90d', 'pr_vol_200d', 'pr_vol_1y'
];

const PERIOD_MS = {
  '15m': 15 * 60 * 1000, '30m': 30 * 60 * 1000, '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000, '12h': 12 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000, '14d': 14 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000,
  '60d': 60 * 24 * 60 * 60 * 1000, '90d': 90 * 24 * 60 * 60 * 1000, '200d': 200 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000
};

// ===== CSV POMOĆNE =====
function parseCsvShared(tekst) {
  if (!tekst) return [];
  const linije = tekst.trim().split('\n');
  const redovi = [];
  for (let i = 1; i < linije.length; i++) {
    const d = linije[i].split(',');
    if (d.length < 4) continue;
    const vreme = parseInt(d[1], 10), cena = parseFloat(d[2]), vol24 = parseFloat(d[3]);
    if (!isFinite(vreme) || !isFinite(cena)) continue;
    redovi.push({ simbol: d[0], vreme, cena, vol24: isFinite(vol24) ? vol24 : 0 });
  }
  return redovi;
}

function parseCsvToken(tekst) {
  if (!tekst) return [];
  const linije = tekst.trim().split('\n');
  const redovi = [];
  for (let i = 1; i < linije.length; i++) {
    const d = linije[i].split(',');
    if (d.length < 3) continue;
    const vreme = parseInt(d[0], 10), cena = parseFloat(d[1]), vol24 = parseFloat(d[2]);
    if (!isFinite(vreme) || !isFinite(cena)) continue;
    redovi.push({ vreme, cena, vol24: isFinite(vol24) ? vol24 : 0 });
  }
  return redovi;
}

function napraviCsvShared(redovi) {
  let out = 'simbol,vreme,cena,vol24\n';
  for (const r of redovi) out += `${r.simbol},${r.vreme},${r.cena},${r.vol24}\n`;
  return out;
}

function napraviCsvToken(redovi) {
  let out = 'vreme,cena,vol24\n';
  for (const r of redovi) out += `${r.vreme},${r.cena},${r.vol24}\n`;
  return out;
}

function linearnaInterpolacija(t1, v1, t2, v2, tTarget) {
  if (t2 === t1) return v1;
  const proc = (tTarget - t1) / (t2 - t1);
  return v1 + proc * (v2 - v1);
}

async function getKesCsv(env, putanja) {
  const token = env.GITHUB_TOKEN;
  if (!token) return { postoji: false, tekst: '' };
  const url = `https://api.github.com/repos/DenMartinCom/sajt-u-izradi/contents/${putanja}`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'KriptoWorker/1.0' } });
    if (!res.ok) return { postoji: false, tekst: '' };
    const d = await res.json();
    if (!d.content) return { postoji: false, tekst: '' };
    const tekst = decodeURIComponent(escape(atob(d.content.replace(/\n/g, ''))));
    return { postoji: true, sha: d.sha, tekst };
  } catch (e) { return { postoji: false, tekst: '' }; }
}

async function upisiKesCsv(env, putanja, tekst) {
  try { return await gitHubUpload(env, putanja, tekst); } catch (e) { return { ok: false, error: e.message }; }
}

// ===== EXTERNI FETCHERS =====
async function getCgMarkets(env) {
  if (cgMarketsKeš && (Date.now() - cgMarketsKešVreme) < 3600000) return cgMarketsKeš;
  try {
    const url = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&price_change_percentage=1h,24h,7d,14d,30d,200d,1y';
    const r = await fetchSaRateLimit(url, { headers: { 'x-cg-demo-api-key': env.COINGEKO_KEY, 'Accept': 'application/json' } }, 'coingecko');
    if (!r.ok) { await zabeleziGresku(env, 'coingecko', r.status); return cgMarketsKeš || []; }
    const d = await r.json();
    if (Array.isArray(d)) {
      cgMarketsKeš = d; cgMarketsKešVreme = Date.now();
      await zabeleziUpit(env, 'coingecko', 'batch');
      return d;
    }
  } catch (e) {}
  return cgMarketsKeš || [];
}

async function getCoinstatsList(env) {
  if (csListaKeš && (Date.now() - csListaKešVreme) < 3600000) return csListaKeš;
  const KEY = env.COINSTATS_KEY; if (!KEY) return [];
  try {
    const r = await fetchSaRateLimit('https://openapiv1.coinstats.app/coins?limit=500', { headers: { 'X-API-KEY': KEY, 'Accept': 'application/json' } }, 'coinstats');
    if (!r.ok) { await zabeleziGresku(env, 'coinstats', r.status); return csListaKeš || []; }
    const d = await r.json();
    if (d && Array.isArray(d.result)) {
      csListaKeš = d.result; csListaKešVreme = Date.now();
      await zabeleziUpit(env, 'coinstats', 'batch');
      return d.result;
    }
  } catch (e) {}
  return csListaKeš || [];
}

async function getCpTickeri(env) {
  if (cpTickeriKeš && (Date.now() - cpTickeriKešVreme) < 3600000) return cpTickeriKeš;
  try {
    const r = await fetchSaRateLimit('https://api.coinpaprika.com/v1/tickers?quotes=USD', {}, 'coinpaprika');
    if (!r.ok) { await zabeleziGresku(env, 'coinpaprika', r.status); return cpTickeriKeš || []; }
    const d = await r.json();
    if (Array.isArray(d)) {
      cpTickeriKeš = d; cpTickeriKešVreme = Date.now();
      await zabeleziUpit(env, 'coinpaprika', 'batch');
      return d;
    }
  } catch (e) {}
  return cpTickeriKeš || [];
}

// ===== KRAJ DEO 3/7 =====
// ===== POMOĆNA: nađi koji servisi mogu da dopune polja =====
function servisiKojiDaju(polje) {
  const lista = [];
  for (const [servis, polja] of Object.entries(POLJA_PROBLEMATICNA)) {
    if (polja.includes(polje)) lista.push(servis);
  }
  return lista;
}

function parsirajFali(s) {
  if (!s) return [];
  return s.split(',').map(x => x.trim()).filter(x => x);
}

function nadjiFaliPolja(red) {
  const fali = [];
  for (const p of SVA_POLJA) {
    if (red[p] === null || red[p] === undefined) fali.push(p);
  }
  return fali;
}

function nadjiSimbolPoIdZaServis(meta, servis, id) {
  if (servis === 'cmc') return nadjiSimbolPoCmcuId(meta, id);
  if (servis === 'coingecko') return nadjiSimbolPoCgId(meta, id);
  if (servis === 'coinstats') return nadjiSimbolPoCsId(meta, id);
  if (servis === 'coinpaprika') return nadjiSimbolPoCpId(meta, id);
  if (servis === 'cryptorank') return nadjiSimbolPoCrId(meta, id);
  return null;
}

function idZaServis(m, servis) {
  if (servis === 'cmc') return m.cmc;
  if (servis === 'coingecko') return m.coingecko;
  if (servis === 'coinstats') return m.coinstats;
  if (servis === 'coinpaprika') return m.coinpaprika;
  if (servis === 'cryptorank') return m.cryptorank;
  return null;
}

// ===== FORMIRANJE STRANE (bulk do bulk_max) =====
async function formirajStranu(env, servis, bulkMax) {
  const meta = await getKriptoMeta(env);
  const p = await getParametri(env);
  const intervalSek = parseInt(p['kes_interval_sek'] || '900', 10);
  const sada = Date.now();
  const granicaStaro = sada - intervalSek * 1000;

  const kesRows = await env.DB.prepare("SELECT token, vreme, fali FROM kripto_kes").all();
  const kesMapa = {};
  for (const r of kesRows.results) kesMapa[r.token] = r;

  const poljaServisa = POLJA_PROBLEMATICNA[servis] || [];

  const kandidatiA = [];
  const kandidatiB = [];

  for (const [simbol, m] of Object.entries(meta)) {
    const id = idZaServis(m, servis);
    if (!id) continue;

    const kes = kesMapa[simbol];
    if (!kes || kes.vreme < granicaStaro) {
      kandidatiA.push({ simbol, id, vreme: kes ? kes.vreme : 0 });
      continue;
    }

    if (poljaServisa.length) {
      const faliList = parsirajFali(kes.fali);
      const presek = faliList.filter(f => poljaServisa.includes(f));
      if (presek.length) kandidatiB.push({ simbol, id, fali: presek });
    }
  }

  kandidatiA.sort((a, b) => a.vreme - b.vreme);

  const strana = [];
  for (const k of kandidatiA) {
    if (strana.length >= bulkMax) break;
    strana.push(k);
  }
  if (strana.length < bulkMax && kandidatiB.length) {
    for (const k of kandidatiB) {
      if (strana.length >= bulkMax) break;
      strana.push(k);
    }
  }

  return strana;
}

// ===== DOPUNA IZ KESA (korak 4) =====
async function dopuniIzKesa(env) {
  const p = await getParametri(env);
  const intervalSek = parseInt(p['kes_interval_sek'] || '900', 10);
  const sada = Date.now();

  const danas = new Date().toISOString().slice(0, 10);
  const juce = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const csvDanas = await getKesCsv(env, `0_Arhiva/Kesh/${danas}.csv`);
  const csvJuce = await getKesCsv(env, `0_Arhiva/Kesh/${juce}.csv`);

  const sveTacke = [];
  if (csvJuce.postoji) sveTacke.push(...parseCsvShared(csvJuce.tekst));
  if (csvDanas.postoji) sveTacke.push(...parseCsvShared(csvDanas.tekst));

  const poSimbolu = {};
  for (const t of sveTacke) {
    if (!poSimbolu[t.simbol]) poSimbolu[t.simbol] = [];
    poSimbolu[t.simbol].push(t);
  }
  for (const s in poSimbolu) poSimbolu[s].sort((a, b) => a.vreme - b.vreme);

  const kesRows = await env.DB.prepare("SELECT * FROM kripto_kes").all();
  const updates = [];

  for (const row of kesRows.results) {
    const simbol = row.token;
    const tacke = poSimbolu[simbol];
    if (!tacke || !tacke.length) continue;

    const izmene = {};
    for (const polje of SVA_POLJA) {
      if (row[polje] !== null && row[polje] !== undefined) continue;

      const m = polje.match(/^pr_(cena|vol)_(.+)$/);
      if (!m) continue;
      const tip = m[1];
      const periodStr = m[2];
      const periodMsLokal = PERIOD_MS[periodStr];
      if (!periodMsLokal) continue;

      const target = sada - periodMsLokal;

      const vrednost = nadjiIliInterpoliraj(tacke, target, tip);
      if (vrednost === null) continue;

      const sadaVrednost = (tip === 'cena') ? row.cena : row.volumen_24h;
      if (!sadaVrednost || !vrednost) continue;

      const promena = (sadaVrednost - vrednost) / vrednost * 100;
      izmene[polje] = parseFloat(promena.toFixed(2));
    }

    if (Object.keys(izmene).length) updates.push({ simbol, izmene });
  }

  const GRUPA = 30;
  for (let i = 0; i < updates.length; i += GRUPA) {
    const grupa = updates.slice(i, i + GRUPA);
    const stmts = [];
    for (const u of grupa) {
      const polja = Object.keys(u.izmene);
      const setStr = polja.map(p => `${p} = ?`).join(', ');
      const vrednosti = polja.map(p => u.izmene[p]);
      vrednosti.push(u.simbol);
      stmts.push(env.DB.prepare(`UPDATE kripto_kes SET ${setStr} WHERE token = ?`).bind(...vrednosti));
    }
    try { await env.DB.batch(stmts); } catch (e) {
      for (const s of stmts) { try { await s.run(); } catch (e2) {} }
    }
  }

  return updates.length;
}

function nadjiIliInterpoliraj(tacke, target, tip) {
  if (!tacke.length) return null;

  let pre = null, posle = null;
  for (const t of tacke) {
    if (t.vreme <= target) pre = t;
    if (t.vreme >= target && !posle) posle = t;
  }

  const polje = (tip === 'cena') ? 'cena' : 'vol24';

  if (pre && posle && pre.vreme !== posle.vreme) {
    return linearnaInterpolacija(pre.vreme, pre[polje], posle.vreme, posle[polje], target);
  }
  if (pre) return pre[polje];
  if (posle) return posle[polje];
  return null;
}

// ===== UPIS SHARED CSV (korak 5) =====
async function upisiSharedCsv(env) {
  const danas = new Date().toISOString().slice(0, 10);
  const putanja = `0_Arhiva/Kesh/${danas}.csv`;

  const rows = await env.DB.prepare("SELECT token, cena, volumen_24h FROM kripto_kes WHERE cena IS NOT NULL").all();
  const sada = Date.now();

  const csv = await getKesCsv(env, putanja);
  let tekst = csv.postoji ? csv.tekst : 'simbol,vreme,cena,vol24\n';

  const noviRedovi = [];
  for (const r of rows.results) {
    const cena = parseFloat(r.cena);
    if (!isFinite(cena)) continue;
    const vol = isFinite(parseFloat(r.volumen_24h)) ? parseFloat(r.volumen_24h) : 0;
    noviRedovi.push(`${r.token},${sada},${cena},${vol}`);
  }

  tekst += noviRedovi.join('\n') + '\n';
  await upisiKesCsv(env, putanja, tekst);
  return noviRedovi.length;
}

// ===== PODELI SHARED U PER-TOKEN =====
async function podeliSharedUPerToken(env) {
  const danas = new Date().toISOString().slice(0, 10);
  const putanja = `0_Arhiva/Kesh/${danas}.csv`;

  const csv = await getKesCsv(env, putanja);
  if (!csv.postoji) return { ok: false, razlog: 'nema shared csv za danas' };

  const tacke = parseCsvShared(csv.tekst);
  const poSimbolu = {};
  for (const t of tacke) {
    if (!poSimbolu[t.simbol]) poSimbolu[t.simbol] = [];
    poSimbolu[t.simbol].push(t);
  }

  const simboli = Object.keys(poSimbolu);
  let upisano = 0;
  const BUDZET_MS = 600000;
  const p0 = Date.now();

  for (const simbol of simboli) {
    if (Date.now() - p0 > BUDZET_MS) break;
    const putanjaToken = `0_Arhiva/Kesh/Token/${simbol}.csv`;
    try {
      const stari = await getKesCsv(env, putanjaToken);
      let tekst = stari.postoji ? stari.tekst : 'vreme,cena,vol24\n';

      const postojeci = stari.postoji ? parseCsvToken(stari.tekst) : [];
      const postojeciSet = new Set(postojeci.map(x => x.vreme));

      const noviRedovi = [];
      for (const t of poSimbolu[simbol]) {
        if (postojeciSet.has(t.vreme)) continue;
        noviRedovi.push(`${t.vreme},${t.cena},${t.vol24}`);
      }
      if (noviRedovi.length) {
        tekst += noviRedovi.join('\n') + '\n';
      }

      const p = await getParametri(env);
      const cuvanjeDana = parseInt(p['hist_cuvanje_dana'] || '30', 10);
      const granica = Date.now() - cuvanjeDana * 86400000;

      const linije = tekst.trim().split('\n');
      const header = linije[0];
      const telo = linije.slice(1).map(l => {
        const d = l.split(',');
        return { vreme: parseInt(d[0], 10), raw: l };
      }).filter(x => isFinite(x.vreme) && x.vreme >= granica);

      telo.sort((a, b) => a.vreme - b.vreme);
      const noviTekst = header + '\n' + telo.map(x => x.raw).join('\n') + (telo.length ? '\n' : '');

      if (noviRedovi.length || stari.postoji) {
        await upisiKesCsv(env, putanjaToken, noviTekst);
        upisano++;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }

  return { ok: true, simboli: simboli.length, upisano };
}

// ===== CIKLUS KES =====
async function ciklusKes(env) { return saGlobalLock(env, 'kes', _ciklusKes); }
async function _ciklusKes(env, workerId, p0) {
  const meta = await getKriptoMeta(env);
  const servisi = await getServisi(env);
  const log = [];

  // KORAK 1: batch — CS ili CP (po održivosti)
  const odrCS = (servisi.coinstats && servisi.coinstats.odrzivost) || 0;
  const odrCP = (servisi.coinpaprika && servisi.coinpaprika.odrzivost) || 0;
  let prviServis = null;
  if (odrCS >= odrCP) prviServis = 'coinstats';
  else prviServis = 'coinpaprika';

  const mapa = {};

  try {
    if (prviServis === 'coinstats') {
      const lista = await getCoinstatsList(env);
      for (const c of lista) {
        const s = nadjiSimbolPoCsId(meta, c.id) || nadjiSimbolPoCgId(meta, c.id) || nadjiSimbolPoCgId(meta, c.slug);
        if (!s) continue;
        if (!c.price) continue;
        if (!mapa[s]) mapa[s] = {};
        mapa[s].cena = parseFloat(c.price);
        Object.assign(mapa[s], mapirajCS(c));
      }
      log.push('1:cs');
    } else {
      const lista = await getCpTickeri(env);
      for (const t of lista) {
        const s = nadjiSimbolPoCpId(meta, t.id);
        if (!s) continue;
        const q = t.quotes?.USD;
        if (!q || !q.price) continue;
        if (!mapa[s]) mapa[s] = {};
        mapa[s].cena = q.price;
        Object.assign(mapa[s], mapirajCP(q, t.rank));
      }
      log.push('1:cp');
    }
  } catch (e) { log.push(`1:greska-${e.message}`); }

  const upisiKes = Object.entries(mapa).filter(([, p]) => p.cena).map(([s, p]) => ({ simbol: s, ...p }));
  if (upisiKes.length) await upisiCeneBulk(env, upisiKes, 'kes-ciklus-1');

  // KORAK 2: bulk — CG ili CR (po održivosti)
  const odrCG = (servisi.coingecko && servisi.coingecko.odrzivost) || 0;
  const odrCR = (servisi.cryptorank && servisi.cryptorank.odrzivost) || 0;
  let drugiServis = (odrCG >= odrCR) ? 'coingecko' : 'cryptorank';
  const bulkMax2 = drugiServis === 'coingecko' ? 250 : 100;

  try {
    const strana = await formirajStranu(env, drugiServis, bulkMax2);
    if (strana.length) {
      const ids = strana.map(x => x.id);
      if (drugiServis === 'coingecko') {
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(',')}&price_change_percentage=1h,24h,7d,14d,30d,200d,1y&sparkline=false`;
        const r = await fetchSaRateLimit(url, { headers: { 'x-cg-demo-api-key': env.COINGEKO_KEY, 'Accept': 'application/json' } }, 'coingecko');
        if (r.ok) {
          const d = await r.json();
          const arr = Array.isArray(d) ? d : [];
          const upis = [];
          for (const c of arr) {
            if (typeof c.current_price !== 'number') continue;
            const s = nadjiSimbolPoCgId(meta, c.id);
            if (!s) continue;
            upis.push({ simbol: s, cena: c.current_price, ...mapirajCG(c) });
          }
          if (upis.length) await upisiCeneBulk(env, upis, 'kes-ciklus-2');
          await zabeleziUpit(env, 'coingecko', 'bulk', ids.length);
          log.push(`2:cg-${ids.length}`);
        } else { log.push(`2:cg-http-${r.status}`); }
      } else {
        const r = await fetch(`https://api.cryptorank.io/v3/currencies/list?currencyIds=${ids.join(',')}`, { headers: { 'X-Api-Key': env.CRYPTORANK_KEY, 'Accept': 'application/json' } });
        if (r.ok) {
          const d = await r.json();
          const arr = (d && Array.isArray(d.data)) ? d.data : [];
          const upis = [];
          for (const c of arr) {
            const s = nadjiSimbolPoCrId(meta, c.id);
            if (!s) continue;
            const cena = crCena(c.price);
            if (!cena) continue;
            const p = { cena };
            if (c.marketCap) p.market_cap = parseFloat(c.marketCap);
            if (c.volume24h) p.volumen_24h = parseFloat(c.volume24h);
            if (c.rank) p.rank = c.rank;
            if (c.priceChangePercent24h != null) p.pr_cena_24h = parseFloat(c.priceChangePercent24h);
            upis.push({ simbol: s, ...p });
          }
          if (upis.length) await upisiCeneBulk(env, upis, 'kes-ciklus-2');
          await zabeleziUpit(env, 'cryptorank', 'bulk', ids.length);
          log.push(`2:cr-${ids.length}`);
        } else { log.push(`2:cr-http-${r.status}`); }
      }
    } else {
      log.push('2:prazna-strana');
    }
  } catch (e) { log.push(`2:greska-${e.message}`); }

  // KORAK 3: bulk — CMC
  const bulkMax3 = 250;
  try {
    const strana = await formirajStranu(env, 'cmc', bulkMax3);
    if (strana.length) {
      const ids = strana.map(x => x.id);
      const r = await fetchSaRateLimit(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?id=${ids.join(',')}&convert=USD&skip_invalid=true&CMC_PRO_API_KEY=${env.CMC_API_KEY}`, {}, 'cmc');
      if (r.ok) {
        const d = await r.json();
        const lista = Object.values(d.data || {});
        const upis = [];
        for (const info of lista) {
          const c = parseFloat(info.quote?.USD?.price);
          if (!c) continue;
          const s = nadjiSimbolPoCmcuId(meta, info.id);
          if (!s) continue;
          upis.push({ simbol: s, cena: c, rank: info.cmc_rank || null, ...mapirajCMC(info.quote.USD, info.cmc_rank) });
        }
        if (upis.length) await upisiCeneBulk(env, upis, 'kes-ciklus-3');
        await zabeleziUpit(env, 'cmc', 'bulk', ids.length);
        log.push(`3:cmc-${ids.length}`);
      } else { log.push(`3:cmc-http-${r.status}`); }
    } else {
      log.push('3:prazna-strana');
    }
  } catch (e) { log.push(`3:greska-${e.message}`); }

  // KORAK 4: dopuna iz CSV-a
  try {
    const dopunjeno = await dopuniIzKesa(env);
    log.push(`4:dopunjeno-${dopunjeno}`);
  } catch (e) { log.push(`4:greska-${e.message}`); }

  // KORAK 5: upis shared CSV
  try {
    const upisano = await upisiSharedCsv(env);
    log.push(`5:csv-${upisano}`);
  } catch (e) { log.push(`5:greska-${e.message}`); }

  // Ažuriraj fali kolonu
  try {
    const kesRows = await env.DB.prepare("SELECT * FROM kripto_kes").all();
    const updates = [];
    for (const r of kesRows.results) {
      const fali = nadjiFaliPolja(r);
      const faliStr = fali.join(',');
      if ((r.fali || '') !== faliStr) {
        updates.push({ simbol: r.token, fali: faliStr });
      }
    }
    const GRUPA = 30;
    for (let i = 0; i < updates.length; i += GRUPA) {
      const grupa = updates.slice(i, i + GRUPA);
      const stmts = grupa.map(u => env.DB.prepare("UPDATE kripto_kes SET fali = ? WHERE token = ?").bind(u.fali, u.simbol));
      try { await env.DB.batch(stmts); } catch (e) {
        for (const s of stmts) { try { await s.run(); } catch (e2) {} }
      }
    }
    log.push(`fali:${updates.length}`);
  } catch (e) { log.push(`fali-greska-${e.message}`); }

  await logCron(env, 'kes-ciklus', 'ok', log.join(' | '), Date.now() - p0);
}

// ===== POSAO KES (legacy) =====
async function posaoKes(env) { return ciklusKes(env); }

// ===== UPARIVANJE =====
async function posaoUparivanje(env, cmcData) {
  const meta = await getKriptoMeta(env);
  const cgMarkets = await getCgMarkets(env);
  const csLista = await getCoinstatsList(env);
  const cpLista = await getCpTickeri(env);

  const prazan = { cg: {auto:[],sumnjivi:[],nenadjeni:[]}, cs: {auto:[],sumnjivi:[],nenadjeni:[]}, cp: {auto:[],sumnjivi:[],nenadjeni:[]} };
  if (!cgMarkets || !cgMarkets.length) return { izvestaj: prazan, novi: [] };

  const cgPoSimbolu = {};
  for (const cg of cgMarkets) { const s = normalizuj(cg.symbol); if (!s) continue; if (!cgPoSimbolu[s]) cgPoSimbolu[s] = []; cgPoSimbolu[s].push(cg); }
  const csPoSimbolu = {};
  for (const cs of csLista) { const s = normalizuj(cs.symbol); if (!s) continue; if (!csPoSimbolu[s]) csPoSimbolu[s] = []; csPoSimbolu[s].push(cs); }
  const cpPoSimbolu = {};
  for (const cp of cpLista) { const s = normalizuj(cp.symbol); if (!s) continue; if (!cpPoSimbolu[s]) cpPoSimbolu[s] = []; cpPoSimbolu[s].push(cp); }

  const izvestaj = { cg: {auto:[], sumnjivi:[], nenadjeni:[]}, cs: {auto:[], sumnjivi:[], nenadjeni:[]}, cp: {auto:[], sumnjivi:[], nenadjeni:[]} };
  const novi = [];

  for (const c of cmcData) {
    const postojiSimbol = nadjiSimbolPoCmcuId(meta, c.id);
    if (postojiSimbol && meta[postojiSimbol].coingecko && meta[postojiSimbol].coinstats && meta[postojiSimbol].coinpaprika) continue;
    const simbol = normalizuj(c.symbol);
    const naziv = c.name;
    const cmc_slug = c.slug;
    const cena = c.quote?.USD?.price ? parseFloat(c.quote.USD.price) : null;
    const rank = c.cmc_rank || null;
    const stab = (c.tags || []).includes('stablecoin') ? 1 : 0;
    const contract = c.platform?.token_address || null;
    const blockchain = c.platform?.name?.toLowerCase() || null;

    const metaToken = postojiSimbol ? meta[postojiSimbol] : { simbol, naziv, coingecko: null, cmc_slug: c.slug };

    let cgId = metaToken.coingecko;
    let csId = metaToken.coinstats;
    let cpId = metaToken.coinpaprika;

    if (!cgId) {
      const kandidati = cgPoSimbolu[simbol] || [];
      for (const krug of [1, 2, 3, 4]) {
        for (const k of kandidati) {
          const res = upariPoSlugICeni(metaToken, k, cena, k.current_price, krug);
          if (res.nadjeno && res.auto) { cgId = k.id; izvestaj.cg.auto.push({ simbol, cmc_slug, id: cgId, rank, naziv, cmc_id: c.id, krug }); break; }
        }
        if (cgId) break;
      }
      if (!cgId && kandidati.length) {
        const k = kandidati[0];
        izvestaj.cg.sumnjivi.push({ simbol, cmc_slug, naziv, rank, cmc_id: c.id, predlog: k.id, naziv_kandidata: k.name, cena_token: cena, cena_kandidata: k.current_price, proc: procRazlika(cena, k.current_price) });
      } else if (!cgId) {
        izvestaj.cg.nenadjeni.push({ simbol, cmc_slug, naziv, rank, cmc_id: c.id, cena });
      }
    }

    if (!csId) {
      const kandidati = csPoSimbolu[simbol] || [];
      for (const krug of [1, 2, 3, 4]) {
        for (const k of kandidati) {
          const res = upariPoSlugICeni(metaToken, k, cena, parseFloat(k.price), krug);
          if (res.nadjeno && res.auto) { csId = k.id; izvestaj.cs.auto.push({ simbol, cmc_slug, id: csId, rank, naziv, cmc_id: c.id, krug }); break; }
        }
        if (csId) break;
      }
      if (!csId && kandidati.length) {
        const k = kandidati[0];
        izvestaj.cs.sumnjivi.push({ simbol, cmc_slug, naziv, rank, cmc_id: c.id, predlog: k.id, naziv_kandidata: k.name, cena_token: cena, cena_kandidata: parseFloat(k.price), proc: procRazlika(cena, parseFloat(k.price)) });
      } else if (!csId) {
        izvestaj.cs.nenadjeni.push({ simbol, cmc_slug, naziv, rank, cmc_id: c.id, cena });
      }
    }

    if (!cpId) {
      const kandidati = cpPoSimbolu[simbol] || [];
      for (const krug of [1, 2, 3, 4]) {
        for (const k of kandidati) {
          const res = upariPoSlugICeni(metaToken, k, cena, k.quotes?.USD?.price, krug);
          if (res.nadjeno && res.auto) { cpId = k.id; izvestaj.cp.auto.push({ simbol, cmc_slug, id: cpId, rank, naziv, cmc_id: c.id, krug }); break; }
        }
        if (cpId) break;
      }
      if (!cpId && kandidati.length) {
        const k = kandidati[0];
        izvestaj.cp.sumnjivi.push({ simbol, cmc_slug, naziv, rank, cmc_id: c.id, predlog: k.id, naziv_kandidata: k.name, cena_token: cena, cena_kandidata: k.quotes?.USD?.price, proc: procRazlika(cena, k.quotes?.USD?.price) });
      } else if (!cpId) {
        izvestaj.cp.nenadjeni.push({ simbol, cmc_slug, naziv, rank, cmc_id: c.id, cena });
      }
    }

    const svePuni = cgId && csId && cpId;
    if (svePuni) {
      try {
        if (postojiSimbol) {
          await env.DB.prepare("UPDATE kripto_meta SET coingecko_id=COALESCE(coingecko_id,?), coinstats_id=COALESCE(coinstats_id,?), coinpaprika_id=COALESCE(coinpaprika_id,?), rank=?, cmc_slug=? WHERE simbol=?")
            .bind(cgId, csId, cpId, rank, c.slug, postojiSimbol).run();
        } else {
          await env.DB.prepare("INSERT OR REPLACE INTO kripto_meta (simbol, naziv, coingecko_id, cmc_id, cmc_slug, coinstats_id, coinpaprika_id, contract, blockchain, je_stablecoin, rank, propali, datum_dodavanja) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)")
            .bind(simbol, naziv, cgId, c.id, c.slug, csId, cpId, contract, blockchain, stab, rank, new Date().toISOString().slice(0,10)).run();
        }
        novi.push({ simbol, naziv, rank, cmc_id: c.id });
      } catch (e) {}
    }
    kriptoMetaKešVreme = 0;
  }

  return { izvestaj, novi };
}

// ===== LOGOI =====
async function posaoLogoi(env) {
  return saGlobalLock(env, 'logoi', async (env, workerId, p0) => {
    const BUDZET_MS = 300000;
    const rows = await env.DB.prepare("SELECT simbol, coingecko_id, coinpaprika_id FROM kripto_meta WHERE propali = 0 AND (logo_lokalno IS NULL OR logo_lokalno = '' OR logo_lokalno = 'Slike/coins/_default.png')").all();
    const tokeni = rows.results;
    if (!tokeni.length) { await logCron(env, 'logoi', 'ok', 'nema sta da se radi', Date.now() - p0); return { preuzeto: 0, nedovuceni: [], ukupno: 0 }; }

    const cgMarkets = await getCgMarkets(env);
    const csLista = await getCoinstatsList(env);
    const cgMap = {}; for (const m of cgMarkets) cgMap[m.id] = m;
    const csMap = {}; for (const c of csLista) { csMap[c.id] = c; if (c.slug) csMap[c.slug] = c; }

    const BATCH = 20;
    let preuzeto = 0, greske = 0;
    const nedovuceni = [];

    for (let i = 0; i < Math.min(tokeni.length, BATCH); i++) {
      if (Date.now() - p0 > BUDZET_MS) break;
      const t = tokeni[i];

      const kandidati = [];
      if (t.coingecko_id && cgMap[t.coingecko_id]) {
        const img = cgMap[t.coingecko_id].image;
        if (img) kandidati.push({ url: img.replace('/large/', '/small/'), izvor: 'coingecko' });
      }
      const cs = csMap[t.coingecko_id] || csMap[t.simbol];
      if (cs && cs.icon) kandidati.push({ url: cs.icon, izvor: 'coinstats' });
      if (t.coinpaprika_id) kandidati.push({ url: `https://static.coinpaprika.com/coin/${t.coinpaprika_id}/logo-thumb.png`, izvor: 'coinpaprika' });

      if (!kandidati.length) {
        try { await env.DB.prepare("UPDATE kripto_meta SET logo_lokalno='Slike/coins/_default.png' WHERE simbol=?").bind(t.simbol).run(); } catch (e) {}
        nedovuceni.push({ simbol: t.simbol, kandidati: [] });
        continue;
      }

      let uspeh = false;
      for (const k of kandidati) {
        const rez = await uploadFileOnGitHub(env, k.url, `Slike/coins/${t.simbol}.png`, `Logo ${t.simbol} (${k.izvor})`);
        if (rez.ok) {
          try { await env.DB.prepare("UPDATE kripto_meta SET logo_lokalno=?, logo_url=? WHERE simbol=?").bind(`Slike/coins/${t.simbol}.png`, k.url, t.simbol).run(); } catch (e) {}
          preuzeto++;
          uspeh = true;
          break;
        }
      }

      if (!uspeh) {
        try { await env.DB.prepare("UPDATE kripto_meta SET logo_lokalno='Slike/coins/_default.png' WHERE simbol=?").bind(t.simbol).run(); } catch (e) {}
        greske++;
        nedovuceni.push({ simbol: t.simbol, kandidati: kandidati.map(k => ({ url: k.url, izvor: k.izvor })) });
      }

      await new Promise(r => setTimeout(r, 150));
    }

    kriptoMetaKešVreme = 0;
    await logCron(env, 'logoi', 'ok', `preuzeto:${preuzeto}, greske:${greske}, ostalo:${Math.max(0, tokeni.length - BATCH)}`, Date.now() - p0);
    return { preuzeto, nedovuceni, ukupno: tokeni.length };
  });
}

// ===== PROVERI ARHIVA USLOV =====
async function proveriArhivaUslov(env) {
  const p = await getParametri(env);
  const min = parseFloat(p['arhiva_min_odrzivost'] || '1');
  const servisi = ['cmc', 'coingecko', 'coinstats', 'coinpaprika'];
  const svi = await getServisi(env);
  for (const naziv of servisi) {
    const s = svi[naziv];
    if (!s) continue;
    const odr = s.odrzivost;
    if (odr === null || odr === undefined) continue;
    if (odr < min) return { ok: false, razlog: `${naziv}: ${parseFloat(odr).toFixed(2)} < ${min}` };
  }
  return { ok: true };
}

// ===== KRAJ DEO 4/7 =====

// ===== POSAO ARHIVA (POPRAVLJENO: dodat wrapper) =====
async function posaoArhiva(env) { return saGlobalLock(env, 'arhiva', _posaoArhiva); }
async function _posaoArhiva(env, workerId, p0) {
  const BUDZET_MS = 840000;
  const SUBREQUEST_LIMIT = 40;
  const BATCH_SIZE = 6;
  const danas = new Date().toISOString().slice(0, 10);

  const uslov = await proveriArhivaUslov(env);
  if (!uslov.ok) {
    await logCron(env, 'arhiva', 'ok', 'preskoceno — ' + uslov.razlog, Date.now() - p0);
    return;
  }

  const dnevniPutanja = `0_Arhiva/Dnevna/${danas}.json`;
  const dnevniPostoji = await getGitHubFajl(env, dnevniPutanja);
  if (dnevniPostoji.postoji) {
    await logCron(env, 'arhiva', 'ok', 'dnevni JSON već postoji', Date.now() - p0);
    return;
  }

  const greskeArhive = [];
  let cmcData = null;

  try {
    const r = await fetchSaRateLimit(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=250&convert=USD&CMC_PRO_API_KEY=${env.CMC_API_KEY}`, {}, 'cmc');
    if (r.ok) {
      const d = await r.json();
      cmcData = d.data || [];
      await zabeleziUpit(env, 'cmc', 'batch');
    } else {
      await zabeleziGresku(env, 'cmc', r.status);
      greskeArhive.push(`CMC HTTP ${r.status} — uparivanje/logoi preskoceni`);
    }
  } catch (e) {
    await zabeleziGresku(env, 'cmc', 'timeout');
    greskeArhive.push('CMC timeout — uparivanje/logoi preskoceni');
  }

  let uparivanje = null;
  let logoiRez = null;
  if (cmcData) {
    const meta = await getKriptoMeta(env);
    const upisiKes = [];
    for (const c of cmcData) {
      const simbolPostoji = nadjiSimbolPoCmcuId(meta, c.id);
      if (simbolPostoji && c.slug && meta[simbolPostoji].cmc_slug !== c.slug) {
        try { await env.DB.prepare("UPDATE kripto_meta SET cmc_slug = ?, rank = ? WHERE simbol = ?").bind(c.slug, c.cmc_rank || null, simbolPostoji).run(); } catch (e) {}
      }
      if (simbolPostoji && c.quote?.USD?.price) {
        upisiKes.push({ simbol: simbolPostoji, cena: parseFloat(c.quote.USD.price), rank: c.cmc_rank || null, ...mapirajCMC(c.quote.USD, c.cmc_rank) });
      }
    }
    if (upisiKes.length) await upisiCeneBulk(env, upisiKes, 'cmc-arhiva');
    kriptoMetaKešVreme = 0;

    uparivanje = await posaoUparivanje(env, cmcData);
    logoiRez = await posaoLogoi(env);

    if (uparivanje && uparivanje.novi && uparivanje.novi.length > 0) {
      try {
        await env.DB.prepare("UPDATE parametri SET vrednost='1' WHERE kljuc='primeni_mape'").run();
        parametriKešVreme = 0;
        await logCron(env, 'primeni-mape-signal', 'ok', `${uparivanje.novi.length} novih tokena`, 0);
      } catch (e) {}
    }
  }

  let metaRez = null;
  let metaTrebala = false;
  const intervalDana = parseInt((await getParametri(env))['meta_interval_dana'] || '30', 10);
  const zadnjiMeta = await env.DB.prepare("SELECT vreme FROM cron_log WHERE tip='meta' AND status='ok' ORDER BY vreme DESC LIMIT 1").first();
  const trebaMeta = !zadnjiMeta || (Date.now() - zadnjiMeta.vreme) > intervalDana * 24 * 3600000;
  if (trebaMeta) {
    metaTrebala = true;
    metaRez = await posaoMeta(env);
    if (!metaRez || metaRez.dopunjeno === 0) greskeArhive.push('Meta je trebala, ali nije izvršena');
  }

  const rows = await env.DB.prepare(`
    SELECT k.token, k.cena, k.volumen_24h, k.market_cap, k.rank,
           k.pr_cena_1h, k.pr_cena_6h, k.pr_cena_12h, k.pr_cena_24h,
           k.pr_cena_7d, k.pr_cena_14d, k.pr_cena_30d,
           k.pr_cena_60d, k.pr_cena_90d, k.pr_vol_24h
    FROM kripto_kes k
    INNER JOIN kripto_meta m ON m.simbol = k.token
    WHERE m.propali = 0
  `).all();
  const tokeni = {};
  for (const r of rows.results) {
    if (!r.cena) continue;
    tokeni[r.token] = {
      c: zaokruziCenu(r.cena), v: zaokruziVolumen(r.volumen_24h), mc: zaokruziVolumen(r.market_cap), r: r.rank,
      p1h: zaokruziProcenat(r.pr_cena_1h), p6h: zaokruziProcenat(r.pr_cena_6h), p12h: zaokruziProcenat(r.pr_cena_12h),
      p24h: zaokruziProcenat(r.pr_cena_24h), p7d: zaokruziProcenat(r.pr_cena_7d), p14d: zaokruziProcenat(r.pr_cena_14d),
      p30d: zaokruziProcenat(r.pr_cena_30d), p60d: zaokruziProcenat(r.pr_cena_60d), p90d: zaokruziProcenat(r.pr_cena_90d),
      pv24h: zaokruziProcenat(r.pr_vol_24h)
    };
  }
  const sadrzaj = JSON.stringify({ datum: danas, vreme: new Date().toISOString(), tokeni });
  const rez = await gitHubUpload(env, dnevniPutanja, sadrzaj);
  await logCron(env, 'arhiva-dnevni', rez.ok ? 'ok' : 'greska', rez.ok ? `${Object.keys(tokeni).length} tokena` : `HTTP ${rez.status}`, 0);

  const metaRows = await env.DB.prepare("SELECT simbol FROM kripto_meta WHERE propali = 0 ORDER BY simbol").all();
  const simboli = metaRows.results.map(r => r.simbol);

  const sviKes = await env.DB.prepare("SELECT token, cena, volumen_24h, rank FROM kripto_kes WHERE token IN (SELECT simbol FROM kripto_meta WHERE propali = 0)").all();
  const kesMapa = {};
  for (const r of sviKes.results) kesMapa[r.token] = r;

  const cp = await citajCheckpoint(env, 'arhiva');
  const startIndeks = cp && cp.zadnji_indeks ? cp.zadnji_indeks : 0;

  let uspelo = 0, greskePT = 0, preskoceno = 0;
  let prekinut = false, zadnjiIndeks = startIndeks, subrequestBrojac = 0;
  const greskeLista = [];

  for (let i = startIndeks; i < simboli.length; i++) {
    if (Date.now() - p0 > BUDZET_MS) { prekinut = true; break; }
    if (subrequestBrojac >= SUBREQUEST_LIMIT) { prekinut = true; break; }
    if (uspelo + greskePT >= BATCH_SIZE) { prekinut = true; break; }
    if (i % 2 === 0) await osveziHeartbeat(env, 'global', workerId);
    const simbol = simboli[i];
    zadnjiIndeks = i + 1;
    const kesRow = kesMapa[simbol];
    if (!kesRow || !kesRow.cena) { preskoceno++; continue; }
    const putanja = `0_Arhiva/Coins/${simbol}.json`;
    subrequestBrojac++;
    const stari = await getGitHubFajlSaSadrzajem(env, putanja);
    const podaci = stari.postoji && stari.sadrzaj && Array.isArray(stari.sadrzaj.podaci) ? stari.sadrzaj.podaci : [];
    if (podaci.length > 0 && podaci[0].d === danas) { preskoceno++; continue; }
    podaci.unshift({ d: danas, c: zaokruziCenu(kesRow.cena), v: zaokruziVolumen(kesRow.volumen_24h), r: kesRow.rank });
    const novi = JSON.stringify({ simbol, podaci: podaci.slice(0, 2000) });
    subrequestBrojac += 2;
    const rez2 = await gitHubUpload(env, putanja, novi);
    if (rez2.ok) uspelo++;
    else { greskePT++; if (greskeLista.length < 20) greskeLista.push(`${simbol}: ${rez2.error || `HTTP ${rez2.status}`}`); }
    await new Promise(r => setTimeout(r, 200));
  }

  let perTokenPoruka;
  if (prekinut && zadnjiIndeks < simboli.length) {
    await zapisiCheckpoint(env, 'arhiva', { zadnji_indeks: zadnjiIndeks, ukupno: simboli.length, vreme: Date.now() });
    perTokenPoruka = `prekinut — upisano:${uspelo}, preskoceno:${preskoceno}, ostalo:${simboli.length - zadnjiIndeks}`;
  } else {
    await obrisiCheckpoint(env, 'arhiva');
    perTokenPoruka = `zavrseno — upisano:${uspelo}, preskoceno:${preskoceno}`;
  }
  await logCron(env, 'arhiva-per-token', 'ok', perTokenPoruka, 0);

  try {
    const juce = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const putanjaSharedJuce = `0_Arhiva/Kesh/${juce}.csv`;
    const shared = await getKesCsv(env, putanjaSharedJuce);
    if (shared.postoji) {
      const tackeJuce = parseCsvShared(shared.tekst);
      const poSimbolu = {};
      for (const t of tackeJuce) {
        if (!poSimbolu[t.simbol]) poSimbolu[t.simbol] = [];
        poSimbolu[t.simbol].push(t);
      }
      let upisano = 0;
      const p2 = await getParametri(env);
      const cuvanjeDana = parseInt(p2['hist_cuvanje_dana'] || '30', 10);
      const granica = Date.now() - cuvanjeDana * 86400000;

      for (const simbol of Object.keys(poSimbolu)) {
        const putanjaToken = `0_Arhiva/Kesh/Token/${simbol}.csv`;
        try {
          const stari = await getKesCsv(env, putanjaToken);
          const postojeci = stari.postoji ? parseCsvToken(stari.tekst) : [];
          const postojeciSet = new Set(postojeci.map(x => x.vreme));
          const noviRedovi = [];
          for (const t of poSimbolu[simbol]) {
            if (postojeciSet.has(t.vreme)) continue;
            noviRedovi.push({ vreme: t.vreme, cena: t.cena, vol24: t.vol24 });
          }
          if (!noviRedovi.length && stari.postoji) continue;

          const sveTacke = [...postojeci, ...noviRedovi]
            .filter(x => x.vreme >= granica)
            .sort((a, b) => a.vreme - b.vreme);

          const tekst = napraviCsvToken(sveTacke);
          await upisiKesCsv(env, putanjaToken, tekst);
          upisano++;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 100));
      }
      await logCron(env, 'arhiva-kesh-split', 'ok', `juce: ${upisano}/${Object.keys(poSimbolu).length}`, 0);
    }
  } catch (e) {
    await logCron(env, 'arhiva-kesh-split', 'greska', e.message, 0);
  }

  await generisiIzvestaj(env, uparivanje, logoiRez, metaRez, greskeArhive, metaTrebala);

  const uparBroj = uparivanje ? ((uparivanje.izvestaj?.cg?.auto?.length || 0) + (uparivanje.izvestaj?.cs?.auto?.length || 0) + (uparivanje.izvestaj?.cp?.auto?.length || 0)) : 0;
  await logCron(env, 'arhiva', 'ok', `cmc:${cmcData ? 'ok' : 'pao'}, uparivanje:${uparBroj}, logoi:${logoiRez?.preuzeto || 0}${greskeArhive.length ? ' | ' + greskeArhive.join('; ') : ''}`, Date.now() - p0);
}

// ===== GENERISANJE IZVEŠTAJA =====
async function generisiIzvestaj(env, uparivanje, logoiRez, metaRez, greske = [], metaTrebala = false) {
  const u = (uparivanje && uparivanje.izvestaj) || { cg: {auto:[],sumnjivi:[],nenadjeni:[]}, cs: {auto:[],sumnjivi:[],nenadjeni:[]}, cp: {auto:[],sumnjivi:[],nenadjeni:[]} };
  const ukupnoAuto = u.cg.auto.length + u.cs.auto.length + u.cp.auto.length;
  const ukupnoSumnjivi = u.cg.sumnjivi.length + u.cs.sumnjivi.length + u.cp.sumnjivi.length;
  const ukupnoNenadjeni = u.cg.nenadjeni.length + u.cs.nenadjeni.length + u.cp.nenadjeni.length;
  const logoiNedovuceni = logoiRez?.nedovuceni?.length || 0;

  if (ukupnoAuto === 0 && ukupnoSumnjivi === 0 && ukupnoNenadjeni === 0 && logoiNedovuceni === 0 && greske.length === 0) return;

  const danas = new Date().toISOString().slice(0, 10);
  const hhmm = getUTCVremeCrtice();
  const sada = new Date();
  const vremeStr = `${danas} ${String(sada.getUTCHours()).padStart(2,'0')}:${String(sada.getUTCMinutes()).padStart(2,'0')} UTC`;

  let txt = `Izvestaj — ${vremeStr}\n${'='.repeat(60)}\n\n`;
  txt += `Uparivanje: novih ${ukupnoAuto}, sumnjivih ${ukupnoSumnjivi}, neuparenih ${ukupnoNenadjeni}\n`;
  txt += `Logoi: preuzeto ${logoiRez?.preuzeto || 0}, nedovuceno ${logoiNedovuceni}\n`;
  if (metaTrebala) txt += `Meta refresh: ${metaRez ? (metaRez.dopunjeno + '/' + metaRez.ukupno) : 'NIJE IZVRŠENA'}\n`;
  txt += '\n';

  if (greske.length) {
    txt += `${'='.repeat(60)}\n=== GREŠKE ===\n`;
    for (const g of greske) txt += `  - ${g}\n`;
    txt += '\n';
  }

  for (const [servis, ime] of [['cg', 'CoinGecko'], ['cs', 'CoinStats'], ['cp', 'CoinPaprika']]) {
    const s = u[servis];
    if (!s.auto.length && !s.sumnjivi.length && !s.nenadjeni.length) continue;
    txt += `\n${'='.repeat(60)}\n=== ${ime} ===\n`;
    txt += `Auto: ${s.auto.length} | Sumnjivi: ${s.sumnjivi.length} | Nenadjeni: ${s.nenadjeni.length}\n`;

    if (s.auto.length) {
      txt += `\nNOVI (auto):\n`;
      for (const a of s.auto) {
        const link = servis === 'cg' ? `https://www.coingecko.com/en/coins/${a.id}` : servis === 'cs' ? `https://coinstats.app/coins/${a.id}/` : `https://coinpaprika.com/coin/${a.id}/`;
        txt += `  CMC #: ${a.rank || '?'} | ${a.simbol} — ${a.naziv} → ${a.id} (krug ${a.krug}) | CMC ID: ${a.cmc_id}\n`;
        txt += `    ${ime}: ${link}\n`;
      }
    }

    if (s.sumnjivi.length) {
      txt += `\nSUMNJIVI:\n`;
      for (const x of s.sumnjivi) {
        const procTxt = x.proc != null ? x.proc.toFixed(2) + '%' : '?';
        const kolona = servis === 'cg' ? 'coingecko_id' : servis === 'cs' ? 'coinstats_id' : 'coinpaprika_id';
        const link = servis === 'cg' ? `https://www.coingecko.com/en/coins/${x.predlog}` : servis === 'cs' ? `https://coinstats.app/coins/${x.predlog}/` : `https://coinpaprika.com/coin/${x.predlog}/`;
        txt += `  CMC #: ${x.rank || '?'} | ${x.simbol} — ${x.naziv} | CMC ID: ${x.cmc_id}\n`;
        txt += `    Razlog: cena se razlikuje (${procTxt})\n`;
        txt += `    Naša CMC: https://coinmarketcap.com/currencies/${x.cmc_slug || x.simbol}/\n`;
        txt += `    ${ime}: ${link}\n`;
        txt += `    Za brisanje: UPDATE kripto_meta SET ${kolona} = NULL WHERE simbol = '${x.simbol}';\n`;
      }
    }

    if (s.nenadjeni.length) {
      txt += `\nNIJE NAĐENO:\n`;
      const ddgBaza = servis === 'cg' ? 'coingecko.com/en/coins' : servis === 'cs' ? 'coinstats.app/coins' : 'coinpaprika.com/coin';
      for (const x of s.nenadjeni) {
        txt += `  CMC #: ${x.rank || '?'} | ${x.simbol} — ${x.naziv} (cena $${x.cena}) | CMC ID: ${x.cmc_id}\n`;
        txt += `    CMC: https://coinmarketcap.com/currencies/${x.cmc_slug || x.simbol}/\n`;
        txt += `    DDG: https://duckduckgo.com/?q=site:${ddgBaza}/+${x.simbol}\n`;
      }
    }
    txt += '\n';
  }

  if (logoiRez && logoiNedovuceni) {
    txt += `\n${'='.repeat(60)}\n=== LOGOI — NISU DOVUČENI (${logoiNedovuceni}) ===\n`;
    const meta = await getKriptoMeta(env);
    for (const l of logoiRez.nedovuceni) {
      const m = meta[l.simbol];
      txt += `\n  ${l.simbol}${m ? ' — ' + m.naziv : ''}${m && m.rank ? ' (CMC #' + m.rank + ')' : ''}\n`;
      if (m) {
        txt += `    CMC:  https://coinmarketcap.com/currencies/${m.cmc_slug || l.simbol}/\n`;
        if (m.coingecko) txt += `    CG:   https://www.coingecko.com/en/coins/${m.coingecko}\n`;
        if (m.coinstats) txt += `    CS:   https://coinstats.app/coins/${m.coinstats}/\n`;
        if (m.coinpaprika) txt += `    CP:   https://coinpaprika.com/coin/${m.coinpaprika}/\n`;
      }
      for (const k of (l.kandidati || [])) {
        txt += `    Slika (${k.izvor}): ${k.url}\n`;
      }
    }
    txt += '\n';
  }

  await gitHubUpload(env, `0_Reports/${danas}-${hhmm}.txt`, txt);
}

// ===== POSAO META =====
async function posaoMeta(env) { return saGlobalLock(env, 'meta', _posaoMeta); }
async function _posaoMeta(env, workerId, p0) {
  const BUDZET_MS = 300000;
  const meta = await getKriptoMeta(env);
  const raditi = [];
  for (const [simbol, m] of Object.entries(meta)) {
    if (!m.cmc) continue;
    const fali = !m.description || !m.website || !m.explorer || !m.logo_lokalno || m.logo_lokalno === 'Slike/coins/_default.png';
    if (fali) raditi.push({ simbol, m });
  }
  if (!raditi.length) {
    await logCron(env, 'meta', 'ok', 'nema sta da se radi', Date.now() - p0);
    return { dopunjeno: 0, ukupno: 0, logoi: 0 };
  }

  const cp = await citajCheckpoint(env, 'meta');
  const startIndeks = cp && cp.zadnji_indeks ? cp.zadnji_indeks : 0;
  const BATCH = 40;
  let dopunjeno = 0, greske = 0, logoi = 0;
  let prekinut = false, zadnjiIndeks = startIndeks;

  for (let i = startIndeks; i < Math.min(raditi.length, startIndeks + BATCH); i++) {
    if (Date.now() - p0 > BUDZET_MS) { prekinut = true; break; }
    if (i % 5 === 0) await osveziHeartbeat(env, 'global', workerId);
    const { simbol, m } = raditi[i];
    zadnjiIndeks = i + 1;
    try {
      const info = await getCmcInfo(env, m.cmc);
      if (!info) { greske++; continue; }
      let updatePolja = [], updateVrednosti = [];
      if (!m.description && info.description) { updatePolja.push("description = ?"); updateVrednosti.push(info.description.substring(0, 500)); }
      if (!m.website && info.website) { updatePolja.push("website = ?"); updateVrednosti.push(info.website); }
      if (!m.explorer && info.explorer) { updatePolja.push("explorer = ?"); updateVrednosti.push(info.explorer); }
      if (info.logo && (!m.logo_lokalno || m.logo_lokalno === 'Slike/coins/_default.png')) {
        try {
          const rez = await uploadFileOnGitHub(env, info.logo, `Slike/coins/${simbol}.png`, `Logo ${simbol}`);
          if (rez.ok) { updatePolja.push("logo_lokalno = ?"); updateVrednosti.push(`Slike/coins/${simbol}.png`); logoi++; }
        } catch (e) {}
      }
      if (updatePolja.length) {
        updateVrednosti.push(simbol);
        await env.DB.prepare(`UPDATE kripto_meta SET ${updatePolja.join(', ')} WHERE simbol = ?`).bind(...updateVrednosti).run();
        dopunjeno++;
      }
    } catch (e) { greske++; }
    await new Promise(r => setTimeout(r, 300));
  }

  kriptoMetaKešVreme = 0;
  if (prekinut && zadnjiIndeks < raditi.length) {
    await zapisiCheckpoint(env, 'meta', { zadnji_indeks: zadnjiIndeks, ukupno: raditi.length, vreme: Date.now() });
    await logCron(env, 'meta', 'ok', `prekinut — dopunjeno:${dopunjeno}, logoi:${logoi}, ostalo:${raditi.length - zadnjiIndeks}`, Date.now() - p0);
  } else {
    await obrisiCheckpoint(env, 'meta');
    await logCron(env, 'meta', 'ok', `zavrseno — dopunjeno:${dopunjeno}, logoi:${logoi}, greske:${greske}`, Date.now() - p0);
  }
  return { dopunjeno, ukupno: raditi.length, logoi };
}

async function getCmcInfo(env, cmcId) {
  if (!cmcId) return null;
  try {
    const r = await fetchSaRateLimit(`https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail?id=${cmcId}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KriptoSajt/1.0)', 'Accept': 'application/json' } }, 'cmc');
    if (!r.ok) { await zabeleziGresku(env, 'cmc', r.status); return null; }
    const d = await r.json();
    if (!d || !d.data) return null;
    await zabeleziUpit(env, 'cmc', 'pojedinacni');
    const c = d.data;
    return { id: c.id, name: c.name, symbol: c.symbol, slug: c.slug, logo: c.logo || null, description: c.description || null, website: c.urls?.website?.[0] || null, explorer: c.urls?.explorer?.[0] || null, tags: Array.isArray(c.tags) ? c.tags.map(t => typeof t === 'string' ? t : t.name) : [] };
  } catch (e) { await zabeleziGresku(env, 'cmc', 'timeout'); return null; }
}

// ===== POSAO KURS + FEAR =====
async function posaoKursFear(env) { return saGlobalLock(env, 'kurs-fear', _posaoKursFear); }
async function _posaoKursFear(env, workerId, p0) {
  const danas = new Date().toISOString().slice(0, 10);
  try {
    const kp = await env.DB.prepare("SELECT COUNT(*) as broj FROM kursevi WHERE datum=?").bind(danas).first();
    if (!kp || kp.broj < 30) {
      const kurs = await getKurs(env);
      if (kurs) { await env.DB.prepare("UPDATE kes SET podaci=?, vreme=? WHERE servis='allrates' AND kljuc='nbs_danas'").bind(JSON.stringify(kurs), Date.now()).run(); await logCron(env, 'kurs', 'ok', 'upisano', Date.now() - p0); }
    }
  } catch (e) { await logCron(env, 'kurs', 'greska', e.message, Date.now() - p0); }
  try {
    const kes = await env.DB.prepare("SELECT vreme FROM kes WHERE servis='cmc' AND kljuc='fear_greed'").first();
    const danasPoc = new Date(danas + 'T00:00:00Z').getTime();
    if (!kes || kes.vreme < danasPoc) {
      const KEY = env.CMC_API_KEY;
      if (KEY) {
        const r = await fetchSaRateLimit('https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest', { headers: { 'X-CMC_PRO_API_KEY': KEY } }, 'cmc');
        if (r.ok) { const d = await r.json(); await zabeleziUpit(env, 'cmc', 'pojedinacni'); await env.DB.prepare("UPDATE kes SET podaci=?, vreme=? WHERE servis='cmc' AND kljuc='fear_greed'").bind(JSON.stringify(d), Date.now()).run(); await logCron(env, 'fear', 'ok', 'upisano', Date.now() - p0); }
      }
    }
  } catch (e) { await logCron(env, 'fear', 'greska', e.message, Date.now() - p0); }
}

async function getKurs(env) {
  const danas = new Date().toISOString().slice(0, 10);
  try {
    const rows = await env.DB.prepare("SELECT valuta, kurs FROM kursevi WHERE datum=?").bind(danas).all();
    if (rows.results && rows.results.length) {
      const valute = {};
      for (const r of rows.results) valute[r.valuta] = r.kurs;
      return { datum: danas, eur_rsd: valute.EUR || null, usd_rsd: valute.USD || null, valute, izvor: 'NBS (keš)' };
    }
  } catch (e) {}
  try {
    const r = await fetchSaRateLimit('https://allratestoday.com/api/open/central-bank/nbs', { headers: { 'Accept': 'application/json' } }, 'nbs');
    const d = await r.json();
    if (!d || !Array.isArray(d.rates)) return null;
    const datum = d.rate_date || danas;
    const valute = {};
    for (const x of d.rates) {
      if (x.base && x.quote === 'RSD' && typeof x.value === 'number') {
        valute[x.base] = x.value;
        try { await env.DB.prepare("INSERT OR REPLACE INTO kursevi (datum, valuta, kurs) VALUES (?, ?, ?)").bind(datum, x.base, x.value).run(); } catch (e) {}
      }
    }
    await zabeleziUpit(env, 'nbs', 'pojedinacni');
    return { datum, eur_rsd: valute.EUR || null, usd_rsd: valute.USD || null, valute, izvor: 'NBS (sveže)' };
  } catch (e) { return null; }
}

// ===== MARQUEE =====
async function getMarquee(env) {
  try {
    const meta = await getKriptoMeta(env);
    const kesRows = await env.DB.prepare("SELECT token, cena, volumen_24h, pr_cena_1h, pr_cena_24h, market_cap, rank FROM kripto_kes").all();
    const svi = [];
    for (const r of kesRows.results) {
      const m = meta[r.token]; if (!m) continue;
      svi.push({ simbol: r.token, naziv: m.naziv, cena: r.cena, promena_1h: r.pr_cena_1h, promena_24h: r.pr_cena_24h, volumen: r.volumen_24h, market_cap: r.market_cap || null, rank: r.rank || null, je_stablecoin: m.je_stablecoin, cmc_slug: m.cmc_slug, logo: m.logo_lokalno || `Slike/coins/_default.png` });
    }
    const bezStable = svi.filter(x => !x.je_stablecoin);
    const set1 = [...bezStable].filter(x => x.market_cap).sort((a, b) => b.market_cap - a.market_cap).slice(0, 10);
    const set2 = [...bezStable].filter(x => x.promena_24h != null).sort((a, b) => b.promena_24h - a.promena_24h).slice(0, 15);
    const set3 = [...bezStable].filter(x => x.promena_24h != null).sort((a, b) => a.promena_24h - b.promena_24h).slice(0, 15);
    const fiksni = ['zama', 'brent', 'xaut'].map(s => { const r = kesRows.results.find(x => x.token === s); const m = meta[s]; if (!m) return null; return { simbol: s, naziv: m.naziv, cena: r ? r.cena : null, promena_24h: r ? r.pr_cena_24h : null, cmc_slug: m.cmc_slug, logo: m.logo_lokalno || `Slike/coins/_default.png` }; }).filter(x => x);
    return { set1, set2, set3, fiksni, vreme: Date.now() };
  } catch (e) { return { error: e.message }; }
}

// ===== WATCHDOG =====
async function nadjiNedovrsene(env) {
  try { const rows = await env.DB.prepare("SELECT kljuc FROM kes WHERE servis='checkpoint'").all(); return (rows.results || []).map(r => r.kljuc); } catch (e) { return []; }
}

const POSLOVI_MAPA = {
  'kes': ciklusKes,
  'arhiva': posaoArhiva,
  'meta': posaoMeta,
  'kurs-fear': posaoKursFear,
  'logoi': posaoLogoi
};

// ===== MAPIRANJE: primeni sve 4 mape =====
async function primeniMape(env) {
  const fake = { headers: {} };
  const rez = { cg: null, cs: null, cr: null, cp: null };
  try { rez.cg = await mapirajGenericki(env, '0_Arhiva/coingecko_map.json', 'coingecko_id', ['symbol', 'name', 'id'], fake); } catch (e) {}
  try { rez.cs = await mapirajGenericki(env, '0_Arhiva/coinstats_map.json', 'coinstats_id', ['symbol', 'name', 'id'], fake); } catch (e) {}
  try { rez.cr = await mapirajGenericki(env, '0_Arhiva/cryptorank_map.json', 'cryptorank_id', ['symbol', 'name', 'id'], fake); } catch (e) {}
  try { rez.cp = await mapirajGenericki(env, '0_Arhiva/coinpaprika_map.json', 'coinpaprika_id', ['symbol', 'name', 'id'], fake); } catch (e) {}
  return rez;
}

// ===== ODRZAVANJE: osveziMape =====
async function osveziMape(env, p0) {
  const p = await getParametri(env);
  let korak = p['mape_korak'] || 'cg';
  if (korak === '') korak = 'cg';

  const PAUZA_MS = 3000;
  const pauza = () => new Promise(r => setTimeout(r, PAUZA_MS));

  if (korak === 'cg') {
    try {
      const r = await fetch(`https://api.coingecko.com/api/v3/coins/list`, { headers: { 'x-cg-demo-api-key': env.COINGEKO_KEY, 'Accept': 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      const sadrzaj = JSON.stringify(Array.isArray(d) ? d : []);
      await gitHubUpload(env, '0_Arhiva/coingecko_map.json', sadrzaj);
      await zabeleziUpit(env, 'coingecko', 'batch');
      await env.DB.prepare("UPDATE parametri SET vrednost='cs' WHERE kljuc='mape_korak'").run();
      parametriKešVreme = 0;
      await logCron(env, 'mape', 'ok', `cg skinut: ${Array.isArray(d) ? d.length : 0} tokena`, Date.now() - p0);
      await pauza();
      return { korak: 'cg', ok: true, broj: Array.isArray(d) ? d.length : 0 };
    } catch (e) {
      await logCron(env, 'mape', 'greska', `cg: ${e.message}`, Date.now() - p0);
      return { korak: 'cg', ok: false, error: e.message };
    }
  }

  if (korak === 'cs') {
    try {
      let svi = [];
      for (let p2 = 1; p2 <= 10; p2++) {
        const r = await fetch(`https://openapiv1.coinstats.app/coins?limit=100&page=${p2}&sortBy=marketCap&sortDir=desc`, { headers: { 'X-API-KEY': env.COINSTATS_KEY, 'Accept': 'application/json' } });
        if (!r.ok) throw new Error(`strana${p2}: HTTP ${r.status}`);
        const d = await r.json();
        if (d && Array.isArray(d.result)) svi = svi.concat(d.result);
        await zabeleziUpit(env, 'coinstats', 'batch');
        if (p2 < 10) await pauza();
      }
      const sadrzaj = JSON.stringify(svi);
      await gitHubUpload(env, '0_Arhiva/coinstats_map.json', sadrzaj);
      await env.DB.prepare("UPDATE parametri SET vrednost='cr' WHERE kljuc='mape_korak'").run();
      parametriKešVreme = 0;
      await logCron(env, 'mape', 'ok', `cs skinut: ${svi.length} tokena`, Date.now() - p0);
      await pauza();
      return { korak: 'cs', ok: true, broj: svi.length };
    } catch (e) {
      await logCron(env, 'mape', 'greska', `cs: ${e.message}`, Date.now() - p0);
      return { korak: 'cs', ok: false, error: e.message };
    }
  }

  if (korak === 'cr') {
    try {
      const r = await fetch('https://api.cryptorank.io/v3/currencies/map', { headers: { 'X-Api-Key': env.CRYPTORANK_KEY, 'Accept': 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const tekst = await r.text();
      await gitHubUpload(env, '0_Arhiva/cryptorank_map.json', tekst);
      await zabeleziUpit(env, 'cryptorank', 'batch');
      await env.DB.prepare("UPDATE parametri SET vrednost='cp' WHERE kljuc='mape_korak'").run();
      parametriKešVreme = 0;
      await logCron(env, 'mape', 'ok', `cr skinut: ${tekst.length} bajtova`, Date.now() - p0);
      await pauza();
      return { korak: 'cr', ok: true, velicina: tekst.length };
    } catch (e) {
      await logCron(env, 'mape', 'greska', `cr: ${e.message}`, Date.now() - p0);
      return { korak: 'cr', ok: false, error: e.message };
    }
  }

  if (korak === 'cp') {
    try {
      const r = await fetch('https://api.coinpaprika.com/v1/coins', { headers: { 'Accept': 'application/json', 'User-Agent': 'KriptoWorker/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const tekst = await r.text();
      await gitHubUpload(env, '0_Arhiva/coinpaprika_map.json', tekst);
      await env.DB.prepare("UPDATE parametri SET vrednost='mapiraj' WHERE kljuc='mape_korak'").run();
      parametriKešVreme = 0;
      await logCron(env, 'mape', 'ok', `cp skinut: ${tekst.length} bajtova`, Date.now() - p0);
      await pauza();
      return { korak: 'cp', ok: true, velicina: tekst.length };
    } catch (e) {
      await logCron(env, 'mape', 'greska', `cp: ${e.message}`, Date.now() - p0);
      return { korak: 'cp', ok: false, error: e.message };
    }
  }

  if (korak === 'mapiraj') {
    try {
      const rez = await primeniMape(env);
      await env.DB.prepare("UPDATE parametri SET vrednost='' WHERE kljuc='mape_korak'").run();
      await env.DB.prepare("UPDATE parametri SET vrednost='0' WHERE kljuc='zanovi_mape'").run();
      parametriKešVreme = 0;
      await logCron(env, 'mape', 'ok', `mapiranje zavrseno, zanovi_mape=0`, Date.now() - p0);
      return { korak: 'mapiraj', ok: true, rez };
    } catch (e) {
      await logCron(env, 'mape', 'greska', `mapiraj: ${e.message}`, Date.now() - p0);
      return { korak: 'mapiraj', ok: false, error: e.message };
    }
  }

  await env.DB.prepare("UPDATE parametri SET vrednost='cg' WHERE kljuc='mape_korak'").run();
  parametriKešVreme = 0;
  await logCron(env, 'mape', 'greska', `nepoznat korak '${korak}', reset na cg`, Date.now() - p0);
  return { korak: 'reset', ok: false };
}

async function pokreniNedovrsen(env) {
  const p = await getParametri(env);
  if (p['zanovi_mape'] === '1') {
    const rez = await osveziMape(env, Date.now());
    return 'mape-' + rez.korak;
  }

  if (p['primeni_mape'] === '1') {
    try {
      await primeniMape(env);
      await env.DB.prepare("UPDATE parametri SET vrednost='0' WHERE kljuc='primeni_mape'").run();
      parametriKešVreme = 0;
      await logCron(env, 'primeni-mape', 'ok', 'mape primenjene posle arhive', 0);
      return 'primeni-mape';
    } catch (e) {
      await logCron(env, 'primeni-mape', 'greska', e.message, 0);
      return 'primeni-mape-greska';
    }
  }

  const nedovrseni = await nadjiNedovrsene(env);
  if (!nedovrseni.length) return null;
  for (const ime of nedovrseni) {
    const fn = POSLOVI_MAPA[ime];
    if (!fn) continue;
    try { const lock = await env.DB.prepare("SELECT heartbeat FROM poslovi_lock WHERE posao=?").bind('global').first(); if (lock && (Date.now() - lock.heartbeat) < LOCK_MRTAV_MS) continue; } catch (e) {}
    await fn(env); return ime;
  }
  return null;
}

// ===== POMOĆNA: priprema istorije za grafik =====
function pripremiIstoriju(sadrzaj, danaParam) {
  const sve = (sadrzaj && Array.isArray(sadrzaj.podaci)) ? sadrzaj.podaci : [];
  let isecak;
  if (danaParam === 'sve') {
    isecak = sve;
  } else {
    const dana = parseInt(danaParam, 10);
    if (!isFinite(dana) || dana <= 0) isecak = sve;
    else isecak = sve.slice(0, dana);
  }
  const hrono = isecak.slice().reverse();
  return {
    simbol: sadrzaj && sadrzaj.simbol ? sadrzaj.simbol : null,
    podaci: hrono
  };
}

// ===== KRAJ DEO 5/7 =====

// ===== POMOĆNA za /krediti: upis autoritativnog stanja =====
async function upisiStanjeKredita(env, naziv, utroseno, limit, periodKraj) {
  const preostalo = Math.max(0, (limit || 0) - (utroseno || 0));
  const s = (await getServisi(env))[naziv];
  const period = s ? s.period : 'mesec';
  const odrzivost = izracunajOdrzivost(utroseno, limit, periodKraj, period);
  await env.DB.prepare("UPDATE servisi SET utroseno_kredita=?, preostalo_kredita=?, limit_kredita=COALESCE(?, limit_kredita), period_kraj=COALESCE(?, period_kraj), odrzivost=? WHERE naziv=?")
    .bind(utroseno || 0, preostalo, limit, periodKraj, odrzivost, naziv).run();
  servisiKešVreme = 0;
}

// ===== KREDITI — po servisu =====
async function osveziKrediteCMC(env) {
  const KEY = env.CMC_API_KEY;
  if (!KEY) return { error: 'nema CMC_API_KEY' };
  try {
    const r = await fetch('https://pro-api.coinmarketcap.com/v1/key/info', {
      headers: { 'X-CMC_PRO_API_KEY': KEY, 'Accept': 'application/json' }
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const d = await r.json();
    const plan = d.data?.plan || {};
    const usage = d.data?.usage?.current_month || {};
    const limit = plan.credit_limit_monthly || null;
    const used = usage.credits_used || 0;
    const resetTs = plan.credit_limit_monthly_reset_timestamp
      ? new Date(plan.credit_limit_monthly_reset_timestamp).getTime()
      : null;

    await upisiStanjeKredita(env, 'cmc', used, limit, resetTs);
    return { plan: 'Basic', used, limit, left: limit !== null ? limit - used : null, reset: resetTs };
  } catch (e) { return { error: e.message }; }
}

async function osveziKrediteCoinStats(env) {
  const KEY = env.COINSTATS_KEY;
  if (!KEY) return { error: 'nema COINSTATS_KEY' };
  try {
    const r = await fetch('https://openapiv1.coinstats.app/usage/credits', {
      headers: { 'X-API-KEY': KEY, 'Accept': 'application/json' }
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const d = await r.json();
    const limit = d.totalCredits || null;
    const used = d.usedCredits || 0;

    await upisiStanjeKredita(env, 'coinstats', used, limit, null);
    return { used, limit, left: d.remainingCredits || (limit !== null ? limit - used : null) };
  } catch (e) { return { error: e.message }; }
}

// DO NOT DELETE: Alchemy ima DVA ključa:
//   ALCHEMY_KEY        — RPC (eth_getBalance) za /upit i buduće pozive
//   ALCHEMY_ACCESS_KEY — Admin API (usage/krediti), samo za /krediti
// Ne spajati ih — različite namene, različite dozvole.
async function osveziKrediteAlchemy(env) {
  const KEY = env.ALCHEMY_ACCESS_KEY;
  if (!KEY) return { error: 'nema ALCHEMY_ACCESS_KEY' };
  try {
    const sada = new Date();
    const start = new Date(Date.UTC(sada.getUTCFullYear(), sada.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const end = sada.toISOString().slice(0, 10);
    const r = await fetch(`https://admin-api.alchemy.com/v1/usage/summary?startDate=${start}&endDate=${end}`, {
      headers: { 'Authorization': `Bearer ${KEY}`, 'Accept': 'application/json' }
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const d = await r.json();

    const cuRaw = d.data?.totals?.monthToDate?.amount ?? '0';
    const cu = parseInt(cuRaw, 10) || 0;

    const periodKraj = d.data?.billingPeriod?.endTime
      ? new Date(d.data.billingPeriod.endTime).getTime()
      : Date.UTC(sada.getUTCFullYear(), sada.getUTCMonth() + 1, 1);

    await upisiStanjeKredita(env, 'alchemy', cu, null, periodKraj);
    return {
      cu,
      usd: d.data?.totals?.monthToDate?.usd || '0.00',
      period_start: d.data?.billingPeriod?.startTime || start,
      period_end: d.data?.billingPeriod?.endTime || end
    };
  } catch (e) { return { error: e.message }; }
}

async function osveziKrediteCryptorank(env) {
  const KEY = env.CRYPTORANK_KEY;
  if (!KEY) return { error: 'nema CRYPTORANK_KEY' };
  try {
    const r = await fetch(`https://api.cryptorank.io/v3/status`, {
      headers: { 'X-Api-Key': KEY, 'Accept': 'application/json' }
    });

    const headersIzvor = {};
    r.headers.forEach((v, k) => {
      const kljuc = k.toLowerCase();
      if (kljuc.includes('rate') || kljuc.includes('credit') || kljuc.includes('limit') || kljuc.includes('remaining')) {
        headersIzvor[k] = v;
      }
    });

    if (!r.ok) return { error: `HTTP ${r.status}`, headers: headersIzvor };

    const d = await r.json();

    const used = d.credits?.monthlyUsed || 0;
    const limit = d.credits?.monthlyLimit || null;
    const periodKraj = d.currentPeriodEnd ? new Date(d.currentPeriodEnd).getTime() : null;

    await upisiStanjeKredita(env, 'cryptorank', used, limit, periodKraj);
    return {
      plan: d.plan,
      used,
      limit,
      left: d.credits?.monthlyRemaining ?? (limit !== null ? limit - used : null),
      dnevni: {
        used: d.credits?.dailyUsed || 0,
        limit: d.credits?.dailyLimit || null,
        left: d.credits?.dailyRemaining || null
      },
      period_kraj: d.currentPeriodEnd,
      headers: headersIzvor
    };
  } catch (e) { return { error: e.message }; }
}

// ===== POMOĆNA: popuni ID-jeve iz keša do max =====
async function popuniIdsIzKesa(env, servis, broj) {
  const meta = await getKriptoMeta(env);
  const rows = await env.DB.prepare("SELECT token FROM kripto_kes WHERE rank IS NOT NULL ORDER BY rank ASC LIMIT ?").bind(broj).all();
  const simboli = rows.results.map(r => r.token);
  const ids = [];
  for (const s of simboli) {
    const m = meta[s];
    if (!m) continue;
    if (servis === 'cmc' && m.cmc) ids.push(m.cmc);
    else if (servis === 'coingecko' && m.coingecko) ids.push(m.coingecko);
  }
  return ids;
}

// ===== POMOĆNA: vrati grešku sa body-jem =====
async function vratiGresku(r, servis, corsHeaders) {
  let body = null;
  try { body = await r.text(); } catch (e) { body = null; }
  return new Response(JSON.stringify({
    ok: false,
    error: `HTTP ${r.status}`,
    servis,
    status: r.status,
    body: body ? body.slice(0, 500) : null
  }, null, 2), { status: r.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ===== POMOĆNA: link ka servisu za simbol =====
function linkZaServis(servis, simbol, m) {
  if (!m) return null;
  if (servis === 'cmc') return m.cmc_slug ? `https://coinmarketcap.com/currencies/${m.cmc_slug}/` : null;
  if (servis === 'cg') return m.coingecko ? `https://www.coingecko.com/en/coins/${m.coingecko}` : null;
  if (servis === 'cs') return m.coinstats ? `https://coinstats.app/coins/${m.coinstats}/` : null;
  if (servis === 'cp') return m.coinpaprika ? `https://coinpaprika.com/coin/${m.coinpaprika}/` : null;
  if (servis === 'cr') return m.cmc_slug ? `https://cryptorank.io/price/${m.cmc_slug}` : null;
  return null;
}

// ===== POMOĆNA: mapiraj po symbol/name (gazi stare, BATCH D1 update) =====
async function mapirajGenericki(env, githubFajl, kolona, polja, corsHeaders) {
  const GITHUB_RAW = `https://raw.githubusercontent.com/DenMartinCom/sajt-u-izradi/main/${githubFajl}`;
  try {
    const r = await fetch(GITHUB_RAW, { headers: { 'User-Agent': 'KriptoWorker/1.0' } });
    if (!r.ok) return new Response(JSON.stringify({ error: `GitHub raw HTTP ${r.status}`, url: GITHUB_RAW }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const tekst = await r.text();

    let arr = null;
    try {
      const parsed = JSON.parse(tekst);
      if (Array.isArray(parsed)) arr = parsed;
      else if (parsed && Array.isArray(parsed.data)) arr = parsed.data;
      else if (parsed && Array.isArray(parsed.result)) arr = parsed.result;
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Ne mogu da parsiram map: ' + e.message, velicina: tekst.length }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!Array.isArray(arr)) {
      return new Response(JSON.stringify({ error: 'Map nije array (ni { data: [] } ni { result: [] })', tip: typeof arr }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const byPolje1 = {};
    const byPolje2 = {};
    const polje1 = polja[0];
    const polje2 = polja[1];

    for (const c of arr) {
      const id = c[polja[2]] || c.id;
      if (!id) continue;
      const v1 = (c[polje1] || '').toString().toUpperCase();
      const v2 = (c[polje2] || '').toString().toLowerCase();
      if (v1 && !byPolje1[v1]) byPolje1[v1] = id;
      if (v2 && !byPolje2[v2]) byPolje2[v2] = id;
    }

    const rows = await env.DB.prepare(`SELECT simbol, naziv, ${kolona} FROM kripto_meta WHERE propali = 0`).all();
    const tokeni = rows.results;

    let mapirano = 0;
    let preskoceno_sa_id = 0;
    const nenadjeni = [];
    const updates = [];

    for (const t of tokeni) {
      const v1 = (t.simbol || '').toUpperCase();
      const v2 = (t.naziv || '').toLowerCase();

      let newId = null;
      if (v1 && byPolje1[v1]) newId = byPolje1[v1];
      else if (v2 && byPolje2[v2]) newId = byPolje2[v2];

      if (newId) {
        updates.push({ simbol: t.simbol, newId });
        mapirano++;
      } else if (t[kolona]) {
        preskoceno_sa_id++;
      } else {
        nenadjeni.push({ simbol: t.simbol, naziv: t.naziv });
      }
    }

    const GRUPA = 50;
    for (let i = 0; i < updates.length; i += GRUPA) {
      const grupa = updates.slice(i, i + GRUPA);
      const stmts = grupa.map(u => env.DB.prepare(`UPDATE kripto_meta SET ${kolona} = ? WHERE simbol = ?`).bind(u.newId, u.simbol));
      try {
        await env.DB.batch(stmts);
      } catch (e) {
        for (const u of grupa) {
          try { await env.DB.prepare(`UPDATE kripto_meta SET ${kolona} = ? WHERE simbol = ?`).bind(u.newId, u.simbol).run(); } catch (e2) {}
        }
      }
    }

    kriptoMetaKešVreme = 0;

    return new Response(JSON.stringify({
      ok: true,
      ukupno_tokena: tokeni.length,
      mapirano,
      preskoceno_sa_id,
      nenadjeno: nenadjeni.length,
      nenadjeni_prvih_50: nenadjeni.slice(0, 50),
      velicina_fajla_bajtova: tekst.length,
      zapisa_u_mapi: arr.length
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

// ===== KRAJ DEO 6/7 =====

// ===== RUTA: /provera_mapiranosti =====
async function rutaProveraMapiranosti(env, corsHeaders) {
  const workerId = noviWorkerId();
  const lockUzet = await uzmiLock(env, 'provera', workerId);
  if (!lockUzet) {
    return new Response(JSON.stringify({ ok: false, error: 'provera vec u toku' }, null, 2), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    let cmcData = [], cgData = [], csData = [], cpData = [], crData = [];
    const greske = [];

    try {
      const r1 = await fetchSaRateLimit(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=250&start=1&convert=USD&CMC_PRO_API_KEY=${env.CMC_API_KEY}`, {}, 'cmc');
      if (r1.ok) { const d = await r1.json(); cmcData = cmcData.concat(d.data || []); await zabeleziUpit(env, 'cmc', 'batch'); }
      else { greske.push(`cmc strana1: HTTP ${r1.status}`); await zabeleziGresku(env, 'cmc', r1.status); }
    } catch (e) { greske.push(`cmc strana1: ${e.message}`); }

    try {
      const r2 = await fetchSaRateLimit(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=250&start=251&convert=USD&CMC_PRO_API_KEY=${env.CMC_API_KEY}`, {}, 'cmc');
      if (r2.ok) { const d = await r2.json(); cmcData = cmcData.concat(d.data || []); await zabeleziUpit(env, 'cmc', 'batch'); }
      else { greske.push(`cmc strana2: HTTP ${r2.status}`); await zabeleziGresku(env, 'cmc', r2.status); }
    } catch (e) { greske.push(`cmc strana2: ${e.message}`); }

    try {
      const r1 = await fetchSaRateLimit(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&page=1`, { headers: { 'x-cg-demo-api-key': env.COINGEKO_KEY, 'Accept': 'application/json' } }, 'coingecko');
      if (r1.ok) { const d = await r1.json(); cgData = cgData.concat(Array.isArray(d) ? d : []); await zabeleziUpit(env, 'coingecko', 'batch'); }
      else { greske.push(`coingecko strana1: HTTP ${r1.status}`); await zabeleziGresku(env, 'coingecko', r1.status); }
    } catch (e) { greske.push(`coingecko strana1: ${e.message}`); }

    try {
      const r2 = await fetchSaRateLimit(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&page=2`, { headers: { 'x-cg-demo-api-key': env.COINGEKO_KEY, 'Accept': 'application/json' } }, 'coingecko');
      if (r2.ok) { const d = await r2.json(); cgData = cgData.concat(Array.isArray(d) ? d : []); await zabeleziUpit(env, 'coingecko', 'batch'); }
      else { greske.push(`coingecko strana2: HTTP ${r2.status}`); await zabeleziGresku(env, 'coingecko', r2.status); }
    } catch (e) { greske.push(`coingecko strana2: ${e.message}`); }

    const meta = await getKriptoMeta(env);

    for (let p = 1; p <= 10; p++) {
      try {
        const r = await fetchSaRateLimit(`https://openapiv1.coinstats.app/coins?limit=500&page=${p}&sortBy=marketCap&sortDir=desc`, { headers: { 'X-API-KEY': env.COINSTATS_KEY, 'Accept': 'application/json' } }, 'coinstats');
        if (r.ok) { const d = await r.json(); csData = csData.concat((d && Array.isArray(d.result)) ? d.result : []); await zabeleziUpit(env, 'coinstats', 'batch'); }
        else { greske.push(`coinstats strana${p}: HTTP ${r.status}`); await zabeleziGresku(env, 'coinstats', r.status); }
      } catch (e) { greske.push(`coinstats strana${p}: ${e.message}`); }
    }

    try {
      const r = await fetchSaRateLimit('https://api.coinpaprika.com/v1/tickers?quotes=USD', {}, 'coinpaprika');
      if (r.ok) { const d = await r.json(); cpData = Array.isArray(d) ? d : []; await zabeleziUpit(env, 'coinpaprika', 'batch'); }
      else { greske.push(`coinpaprika: HTTP ${r.status}`); await zabeleziGresku(env, 'coinpaprika', r.status); }
    } catch (e) { greske.push(`coinpaprika: ${e.message}`); }

    const crIds = [];
    for (const [s, m] of Object.entries(meta)) {
      if (m.cryptorank) crIds.push(m.cryptorank);
    }
    const crGrupe = [];
    for (let i = 0; i < crIds.length; i += 100) crGrupe.push(crIds.slice(i, i + 100));
    for (let i = 0; i < crGrupe.length; i++) {
      const grupa = crGrupe[i];
      try {
        const r = await fetch(`https://api.cryptorank.io/v3/currencies/list?currencyIds=${grupa.join(',')}`, { headers: { 'X-Api-Key': env.CRYPTORANK_KEY, 'Accept': 'application/json' } });
        if (r.ok) { const d = await r.json(); crData = crData.concat((d && Array.isArray(d.data)) ? d.data : []); await zabeleziUpit(env, 'cryptorank', 'batch'); }
        else { greske.push(`cryptorank grupa${i + 1}: HTTP ${r.status}`); await zabeleziGresku(env, 'cryptorank', r.status); }
      } catch (e) { greske.push(`cryptorank grupa${i + 1}: ${e.message}`); }
    }

    const cmcCene = {}, cgCene = {}, csCene = {}, cpCene = {}, crCene = {};

    for (const c of cmcData) {
      const s = nadjiSimbolPoCmcuId(meta, c.id);
      if (!s) continue;
      const cena = parseFloat(c.quote?.USD?.price);
      if (cena > 0) cmcCene[s] = cena;
    }
    for (const c of cgData) {
      const s = nadjiSimbolPoCgId(meta, c.id);
      if (!s) continue;
      if (typeof c.current_price === 'number' && c.current_price > 0) cgCene[s] = c.current_price;
    }
    for (const c of csData) {
      const s = nadjiSimbolPoCsId(meta, c.id);
      if (!s) continue;
      const cena = parseFloat(c.price);
      if (cena > 0) csCene[s] = cena;
    }
    for (const t of cpData) {
      const s = nadjiSimbolPoCpId(meta, t.id);
      if (!s) continue;
      const cena = t.quotes?.USD?.price;
      if (cena > 0) cpCene[s] = cena;
    }
    for (const c of crData) {
      const s = nadjiSimbolPoCrId(meta, c.id);
      if (!s) continue;
      const cena = crCena(c.price);
      if (cena) crCene[s] = cena;
    }

    const potvRez = await getGitHubFajlSaSadrzajem(env, '0_Reports/potvrdjeno.json');
    const sumRez = await getGitHubFajlSaSadrzajem(env, '0_Reports/sumnjivi.json');
    const nepotpRez = await getGitHubFajlSaSadrzajem(env, '0_Reports/nepotpuni.json');

    const potvrdjeniSet = new Set((potvRez.postoji && potvRez.sadrzaj && Array.isArray(potvRez.sadrzaj.simboli)) ? potvRez.sadrzaj.simboli : []);
    const sumnjiviSet = new Set((sumRez.postoji && sumRez.sadrzaj && Array.isArray(sumRez.sadrzaj.simboli)) ? sumRez.sadrzaj.simboli : []);
    const nepotpuniSet = new Set(
      (nepotpRez.postoji && nepotpRez.sadrzaj && Array.isArray(nepotpRez.sadrzaj.stavke))
        ? nepotpRez.sadrzaj.stavke.map(x => x.simbol)
        : []
    );

    const sviSimboli = Object.keys(meta);
    const noviPotvrdjeni = [];
    const noviSumnjivi = [];
    const noviNepotpuni = [];
    const detalji = [];
    const bezCene = { cmc: [], cg: [], cs: [], cp: [], cr: [] };
    const obradjeniSimboli = [];

    for (const simbol of sviSimboli) {
      if (potvrdjeniSet.has(simbol) || sumnjiviSet.has(simbol) || nepotpuniSet.has(simbol)) continue;

      const m = meta[simbol];
      if (!m) continue;

      const faliId = [];
      if (!m.cmc_slug) faliId.push('cmc');
      if (!m.coingecko) faliId.push('cg');
      if (!m.coinstats) faliId.push('cs');
      if (!m.coinpaprika) faliId.push('cp');

      if (faliId.length) {
        noviNepotpuni.push({ simbol, fali: faliId });
        continue;
      }

      obradjeniSimboli.push(simbol);

      if (!cmcCene[simbol]) bezCene.cmc.push(simbol);
      if (!cgCene[simbol]) bezCene.cg.push(simbol);
      if (!csCene[simbol]) bezCene.cs.push(simbol);
      if (!cpCene[simbol]) bezCene.cp.push(simbol);
      if (!crCene[simbol]) bezCene.cr.push(simbol);

      const cene = {};
      if (cmcCene[simbol]) cene.cmc = cmcCene[simbol];
      if (cgCene[simbol]) cene.cg = cgCene[simbol];
      if (csCene[simbol]) cene.cs = csCene[simbol];
      if (cpCene[simbol]) cene.cp = cpCene[simbol];
      if (crCene[simbol]) cene.cr = crCene[simbol];

      const fali = [];
      if (!cene.cmc) fali.push('cmc');
      if (!cene.cg) fali.push('cg');
      if (!cene.cs) fali.push('cs');
      if (!cene.cp) fali.push('cp');
      if (!cene.cr) fali.push('cr');

      const broj = Object.keys(cene).length;
      if (broj < 3) {
        noviSumnjivi.push(simbol);
        detalji.push({ simbol, brojCena: broj, fali, cene });
        continue;
      }

      const vrednosti = Object.values(cene);
      const min = Math.min(...vrednosti);
      const max = Math.max(...vrednosti);
      const razlika = (max - min) / max;

      if (razlika > 0.02) {
        noviSumnjivi.push(simbol);
        detalji.push({ simbol, brojCena: broj, fali, cene, razlika });
      } else {
        noviPotvrdjeni.push(simbol);
      }
    }

    const sviPotvrdjeni = [...potvrdjeniSet, ...noviPotvrdjeni].sort();
    const sviSumnjivi = [...sumnjiviSet, ...noviSumnjivi].sort();

    const stariNepotpuni = (nepotpRez.postoji && nepotpRez.sadrzaj && Array.isArray(nepotpRez.sadrzaj.stavke)) ? nepotpRez.sadrzaj.stavke : [];
    const sviNepotpuni = [...stariNepotpuni];
    const stariSet = new Set(stariNepotpuni.map(x => x.simbol));
    for (const n of noviNepotpuni) {
      if (!stariSet.has(n.simbol)) sviNepotpuni.push(n);
    }
    sviNepotpuni.sort((a, b) => a.simbol.localeCompare(b.simbol));

    await gitHubUpload(env, '0_Reports/potvrdjeno.json', JSON.stringify({ vreme: Date.now(), simboli: sviPotvrdjeni }, null, 2));
    await gitHubUpload(env, '0_Reports/sumnjivi.json', JSON.stringify({ vreme: Date.now(), simboli: sviSumnjivi }, null, 2));
    await gitHubUpload(env, '0_Reports/nepotpuni.json', JSON.stringify({ vreme: Date.now(), stavke: sviNepotpuni }, null, 2));

    const danas = new Date().toISOString().slice(0, 10);
    detalji.sort((a, b) => {
      if (a.brojCena !== b.brojCena) return b.brojCena - a.brojCena;
      const ra = a.razlika || 0;
      const rb = b.razlika || 0;
      if (ra !== rb) return rb - ra;
      return a.simbol.localeCompare(b.simbol);
    });

    let txt = `Provera mapiranosti — ${danas}\n${'='.repeat(60)}\n\n`;
    txt += `Ukupno simbola u bazi: ${sviSimboli.length}\n`;
    txt += `Preskoceno (vec u fajlovima): ${potvrdjeniSet.size + sumnjiviSet.size + nepotpuniSet.size}\n`;
    txt += `Obradjeno u ovom ciklusu: ${obradjeniSimboli.length}\n`;
    txt += `Nepotpuni (fali ID, preskoceni): ${noviNepotpuni.length}\n\n`;
    txt += `POTVRDJENO: ${noviPotvrdjeni.length}\n`;
    txt += `SUMNJIVO: ${noviSumnjivi.length}\n`;
    if (greske.length) txt += `\nGreske servisa:\n  - ${greske.join('\n  - ')}\n`;
    txt += '\n';

    if (noviNepotpuni.length) {
      txt += `${'='.repeat(60)}\n=== NEPOTPUNI — FALI ID (preskoceni, ne trose kredite) ===\n\n`;
      for (const n of noviNepotpuni) {
        const m = meta[n.simbol];
        txt += `${n.simbol.toUpperCase()}${m && m.naziv ? ' — ' + m.naziv : ''} — fali: ${n.fali.join(', ')}\n`;
        if (m) {
          if (m.cmc_slug) txt += `  CMC: https://coinmarketcap.com/currencies/${m.cmc_slug}/\n`;
          if (m.coingecko) txt += `  CG:  https://www.coingecko.com/en/coins/${m.coingecko}\n`;
          if (m.coinstats) txt += `  CS:  https://coinstats.app/coins/${m.coinstats}/\n`;
          if (m.coinpaprika) txt += `  CP:  https://coinpaprika.com/coin/${m.coinpaprika}/\n`;
        }
        txt += '\n';
      }
    }

    txt += `${'='.repeat(60)}\n=== BEZ CENE PO SERVISU (od ${obradjeniSimboli.length} obradjenih) ===\n\n`;
    for (const k of ['cmc', 'cg', 'cs', 'cp', 'cr']) {
      const lista = bezCene[k].slice().reverse();
      txt += `${k.toUpperCase()}: ${lista.length} tokena bez cene\n`;
      if (lista.length) {
        const prikaz = lista.slice(0, 60).join(', ');
        txt += `  ${prikaz}${lista.length > 60 ? ` ... (+${lista.length - 60} jos)` : ''}\n`;
      }
      txt += '\n';
    }

    if (detalji.length) {
      let poslednjiBroj = null;
      txt += `${'='.repeat(60)}\n=== SUMNJIVI (prvo sa 4/5 cena, pa 3/5, ...) ===\n\n`;
      for (const d of detalji) {
        if (d.brojCena !== poslednjiBroj) {
          txt += `\n${'─'.repeat(60)}\n--- ${d.brojCena}/5 cena ---\n\n`;
          poslednjiBroj = d.brojCena;
        }
        const m = meta[d.simbol];
        let razlog;
        if (d.brojCena < 5) razlog = `nedovoljno cena (${d.brojCena}/5), fali: ${d.fali.join(', ')}`;
        else razlog = `razlika ${(d.razlika * 100).toFixed(2)}%`;

        txt += `${d.simbol.toUpperCase()} — ${razlog}\n`;
        if (m) {
          if (m.naziv) txt += `  Naziv: ${m.naziv}\n`;
          if (d.fali && d.fali.length) {
            for (const f of d.fali) {
              const link = linkZaServis(f, d.simbol, m);
              if (link) txt += `  >>> FALI ${f.toUpperCase()}: ${link}\n`;
              else txt += `  >>> FALI ${f.toUpperCase()}: (nema link)\n`;
            }
          }
          if (m.cmc_slug) txt += `  CMC: https://coinmarketcap.com/currencies/${m.cmc_slug}/\n`;
          if (m.coingecko) txt += `  CG:  https://www.coingecko.com/en/coins/${m.coingecko}\n`;
          if (m.coinstats) txt += `  CS:  https://coinstats.app/coins/${m.coinstats}/\n`;
          if (m.coinpaprika) txt += `  CP:  https://coinpaprika.com/coin/${m.coinpaprika}/\n`;
        }
        txt += `  Cene: ${JSON.stringify(d.cene)}\n\n`;
      }
    }

    await gitHubUpload(env, `0_Reports/provera-${danas}.txt`, txt);

    return new Response(JSON.stringify({
      ok: true,
      ukupno_u_bazi: sviSimboli.length,
      preskoceno: potvrdjeniSet.size + sumnjiviSet.size + nepotpuniSet.size,
      obradjeno: obradjeniSimboli.length,
      potvrdjeno: noviPotvrdjeni.length,
      sumnjivo: noviSumnjivi.length,
      nepotpuno: noviNepotpuni.length,
      bez_cene_po_servisu: {
        cmc: bezCene.cmc.length,
        cg: bezCene.cg.length,
        cs: bezCene.cs.length,
        cp: bezCene.cp.length,
        cr: bezCene.cr.length
      },
      cr_poziva: crGrupe.length,
      greske_servisa: greske
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } finally {
    await pustiLock(env, 'provera', workerId);
  }
}

// ===== RUTA: /coingecko-map-download =====
async function rutaCoingeckoMapDownload(env, corsHeaders) {
  const KEY = env.COINGEKO_KEY;
  if (!KEY) return new Response(JSON.stringify({ error: 'nema COINGEKO_KEY' }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const r = await fetchSaRateLimit(`https://api.coingecko.com/api/v3/coins/list`, { headers: { 'x-cg-demo-api-key': KEY, 'Accept': 'application/json' } }, 'coingecko');
    if (!r.ok) return new Response(JSON.stringify({ error: `HTTP ${r.status}` }), { status: r.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const d = await r.json();
    const sadrzaj = JSON.stringify(Array.isArray(d) ? d : []);
    const rez = await gitHubUpload(env, '0_Arhiva/coingecko_map.json', sadrzaj);
    await zabeleziUpit(env, 'coingecko', 'batch');

    return new Response(JSON.stringify({
      ok: rez.ok,
      status: rez.status,
      broj_tokena: Array.isArray(d) ? d.length : 0,
      velicina_bajtova: sadrzaj.length,
      github: rez.ok ? 'upisano' : (rez.error || `HTTP ${rez.status}`)
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

// ===== RUTA: /coinstats-map-download (POPRAVLJENO: bez duplikata) =====
async function rutaCoinstatsMapDownload(env, corsHeaders) {
  const KEY = env.COINSTATS_KEY;
  if (!KEY) return new Response(JSON.stringify({ error: 'nema COINSTATS_KEY' }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    let svi = [];
    const greske = [];
    for (let p = 1; p <= 10; p++) {
      try {
        const r = await fetchSaRateLimit(`https://openapiv1.coinstats.app/coins?limit=100&page=${p}&sortBy=marketCap&sortDir=desc`, { headers: { 'X-API-KEY': KEY, 'Accept': 'application/json' } }, 'coinstats');
        if (r.ok) {
          const d = await r.json();
          if (d && Array.isArray(d.result)) svi = svi.concat(d.result);
          await zabeleziUpit(env, 'coinstats', 'batch');
        } else {
          greske.push(`strana${p}: HTTP ${r.status}`);
        }
      } catch (e) { greske.push(`strana${p}: ${e.message}`); }
    }

    const sadrzaj = JSON.stringify(svi);
    const rez = await gitHubUpload(env, '0_Arhiva/coinstats_map.json', sadrzaj);

    return new Response(JSON.stringify({
      ok: rez.ok,
      status: rez.status,
      broj_tokena: svi.length,
      velicina_bajtova: sadrzaj.length,
      greske: greske.length ? greske : undefined,
      github: rez.ok ? 'upisano' : (rez.error || `HTTP ${rez.status}`)
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

// ===== RUTA: /cryptorank-map-download =====
async function rutaCryptorankMapDownload(env, corsHeaders) {
  const KEY = env.CRYPTORANK_KEY;
  if (!KEY) return new Response(JSON.stringify({ error: 'nema CRYPTORANK_KEY' }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const r = await fetch('https://api.cryptorank.io/v3/currencies/map', {
      headers: { 'X-Api-Key': KEY, 'Accept': 'application/json' }
    });

    if (!r.ok) {
      return new Response(JSON.stringify({ error: `HTTP ${r.status}` }), { status: r.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const tekst = await r.text();
    const rez = await gitHubUpload(env, '0_Arhiva/cryptorank_map.json', tekst);
    await zabeleziUpit(env, 'cryptorank', 'batch');

    return new Response(JSON.stringify({
      ok: rez.ok,
      status: rez.status,
      velicina_bajtova: tekst.length,
      github: rez.ok ? 'upisano' : (rez.error || `HTTP ${rez.status}`)
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    await zabeleziGresku(env, 'cryptorank', 'timeout');
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

// ===== RUTA: /coinpaprika-map-download =====
async function rutaCoinpaprikaMapDownload(env, corsHeaders) {
  try {
    const r = await fetch('https://api.coinpaprika.com/v1/coins', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'KriptoWorker/1.0' }
    });

    if (!r.ok) {
      return new Response(JSON.stringify({ error: `HTTP ${r.status}` }), { status: r.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const tekst = await r.text();
    const rez = await gitHubUpload(env, '0_Arhiva/coinpaprika_map.json', tekst);

    return new Response(JSON.stringify({
      ok: rez.ok,
      status: rez.status,
      velicina_bajtova: tekst.length,
      github: rez.ok ? 'upisano' : (rez.error || `HTTP ${rez.status}`)
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

// ===== RUTA: /coingecko-mapiraj =====
async function rutaCoingeckoMapiraj(env, corsHeaders) {
  return await mapirajGenericki(env, '0_Arhiva/coingecko_map.json', 'coingecko_id', ['symbol', 'name', 'id'], corsHeaders);
}

// ===== RUTA: /coinstats-mapiraj =====
async function rutaCoinstatsMapiraj(env, corsHeaders) {
  return await mapirajGenericki(env, '0_Arhiva/coinstats_map.json', 'coinstats_id', ['symbol', 'name', 'id'], corsHeaders);
}

// ===== RUTA: /cryptorank-mapiraj =====
async function rutaCryptorankMapiraj(env, corsHeaders) {
  return await mapirajGenericki(env, '0_Arhiva/cryptorank_map.json', 'cryptorank_id', ['symbol', 'name', 'id'], corsHeaders);
}

// ===== RUTA: /coinpaprika-mapiraj =====
async function rutaCoinpaprikaMapiraj(env, corsHeaders) {
  return await mapirajGenericki(env, '0_Arhiva/coinpaprika_map.json', 'coinpaprika_id', ['symbol', 'name', 'id'], corsHeaders);
}

// ===== RUTA: /cs-test2 =====
async function rutaCsTest2(env, url, corsHeaders) {
  const KEY = env.COINSTATS_KEY;
  if (!KEY) return new Response(JSON.stringify({ error: 'nema COINSTATS_KEY' }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const path = url.searchParams.get('path');
  if (!path) return new Response(JSON.stringify({ error: 'nema path (npr. ?path=/coins?limit=500)' }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (!path.startsWith('/')) {
    return new Response(JSON.stringify({ error: 'path mora pocinjati sa /' }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const r = await fetch(`https://openapiv1.coinstats.app${path}`, {
      headers: { 'X-API-KEY': KEY, 'Accept': 'application/json' }
    });

    const headeri = {};
    r.headers.forEach((v, k) => { headeri[k] = v; });

    let body = null;
    const tekst = await r.text();
    try { body = JSON.parse(tekst); } catch (e) { body = tekst; }

    const puno = url.searchParams.get('puno') === '1';
    let bodyZaPrikaz = body;
    if (!puno && body && typeof body === 'object' && Array.isArray(body.result)) {
      bodyZaPrikaz = {
        broj_rezultata: body.result.length,
        meta: body.meta || null,
        prvi: body.result[0]
      };
    }

    return new Response(JSON.stringify({
      status: r.status,
      ok: r.ok,
      path,
      headeri,
      body: bodyZaPrikaz
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

// ===== RUTA: /cr-test2 =====
async function rutaCrTest2(env, url, corsHeaders) {
  const KEY = env.CRYPTORANK_KEY;
  if (!KEY) return new Response(JSON.stringify({ error: 'nema CRYPTORANK_KEY' }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const path = url.searchParams.get('path');
  if (!path) return new Response(JSON.stringify({ error: 'nema path (npr. ?path=/v3/currencies/map)' }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (!path.startsWith('/v3/')) {
    return new Response(JSON.stringify({ error: 'path mora pocinjati sa /v3/' }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const r = await fetch(`https://api.cryptorank.io${path}`, {
      headers: { 'X-Api-Key': KEY, 'Accept': 'application/json' }
    });

    const headeri = {};
    r.headers.forEach((v, k) => { headeri[k] = v; });

    let body = null;
    const tekst = await r.text();
    try { body = JSON.parse(tekst); } catch (e) { body = tekst; }

    return new Response(JSON.stringify({
      status: r.status,
      ok: r.ok,
      path,
      headeri,
      body: typeof body === 'string' ? body.slice(0, 2000) : body
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

// ===== RUTA: /cg-test =====
async function rutaCgTest(env, url, corsHeaders) {
  const KEY = env.COINGEKO_KEY;
  if (!KEY) return new Response(JSON.stringify({ error: 'nema COINGEKO_KEY' }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const r = await fetch('https://api.coingecko.com/api/v3/ping', {
      headers: { 'x-cg-demo-api-key': KEY, 'Accept': 'application/json' }
    });

    const headeri = {};
    r.headers.forEach((v, k) => { headeri[k] = v; });

    let body = null;
    const tekst = await r.text();
    try { body = JSON.parse(tekst); } catch (e) { body = tekst; }

    return new Response(JSON.stringify({
      status: r.status,
      ok: r.ok,
      headeri,
      body
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

// ===== RUTA: /upit =====
async function rutaUpit(env, url, corsHeaders) {
  const servis = url.searchParams.get('servis');
  const tip = url.searchParams.get('tip') || 'pojedinacni';
  const idsParam = url.searchParams.get('ids') || '';

  if (!servis) return new Response(JSON.stringify({ error: 'nema servis' }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const dozvoljeni = ['cmc', 'coingecko', 'coinstats', 'coinpaprika', 'cryptorank', 'alchemy'];
  if (!dozvoljeni.includes(servis)) return new Response(JSON.stringify({ error: 'nepoznat servis', dozvoljeni }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const svi = await getServisi(env);
  const s = svi[servis];
  if (!s) return new Response(JSON.stringify({ error: 'servis nema u tabeli' }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const bulkMax = s.bulk_max || 0;
  let ids = [];
  let brojElemenata = 1;

  const servisiSaBulk = ['cmc', 'coingecko'];
  if (tip !== 'batch' && servisiSaBulk.includes(servis)) {
    if (idsParam === 'max') {
      ids = await popuniIdsIzKesa(env, servis, bulkMax);
    } else if (/^\d+$/.test(idsParam)) {
      ids = await popuniIdsIzKesa(env, servis, parseInt(idsParam, 10));
    } else if (idsParam) {
      ids = idsParam.split(',').map(x => x.trim()).filter(x => x);
    }
    if (!ids.length) return new Response(JSON.stringify({ error: 'nema ids' }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    brojElemenata = ids.length;
  }

  if (tip === 'bulk' && !servisiSaBulk.includes(servis)) {
    return new Response(JSON.stringify({ error: 'servis ne podrzava bulk', servis, podrzava: ['pojedinacni', 'batch'] }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    let rezultat = null;

    if (servis === 'cmc') {
      if (tip === 'batch') {
        const r = await fetchSaRateLimit(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=250&convert=USD&CMC_PRO_API_KEY=${env.CMC_API_KEY}`, {}, 'cmc');
        if (!r.ok) return await vratiGresku(r, servis, corsHeaders);
        rezultat = await r.json();
      } else {
        const r = await fetchSaRateLimit(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?id=${ids.join(',')}&convert=USD&CMC_PRO_API_KEY=${env.CMC_API_KEY}`, {}, 'cmc');
        if (!r.ok) return await vratiGresku(r, servis, corsHeaders);
        rezultat = await r.json();
      }
    } else if (servis === 'coingecko') {
      if (tip === 'batch') {
        const r = await fetchSaRateLimit(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&page=1`, { headers: { 'x-cg-demo-api-key': env.COINGEKO_KEY, 'Accept': 'application/json' } }, 'coingecko');
        if (!r.ok) return await vratiGresku(r, servis, corsHeaders);
        rezultat = await r.json();
      } else {
        const r = await fetchSaRateLimit(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(',')}`, { headers: { 'x-cg-demo-api-key': env.COINGEKO_KEY, 'Accept': 'application/json' } }, 'coingecko');
        if (!r.ok) return await vratiGresku(r, servis, corsHeaders);
        rezultat = await r.json();
      }
    } else if (servis === 'coinstats') {
      if (tip === 'pojedinacni') {
        const coinId = idsParam || 'bitcoin';
        const r = await fetchSaRateLimit(`https://openapiv1.coinstats.app/coins/${coinId}`, { headers: { 'X-API-KEY': env.COINSTATS_KEY, 'Accept': 'application/json' } }, 'coinstats');
        if (!r.ok) return await vratiGresku(r, servis, corsHeaders);
        rezultat = await r.json();
      } else {
        const r = await fetchSaRateLimit('https://openapiv1.coinstats.app/coins?limit=500', { headers: { 'X-API-KEY': env.COINSTATS_KEY, 'Accept': 'application/json' } }, 'coinstats');
        if (!r.ok) return await vratiGresku(r, servis, corsHeaders);
        rezultat = await r.json();
      }
    } else if (servis === 'coinpaprika') {
      if (tip === 'pojedinacni') {
        const coinId = idsParam || 'btc-bitcoin';
        const r = await fetchSaRateLimit(`https://api.coinpaprika.com/v1/tickers/${coinId}`, { headers: { 'Accept': 'application/json' } }, 'coinpaprika');
        if (!r.ok) return await vratiGresku(r, servis, corsHeaders);
        rezultat = await r.json();
      } else {
        const r = await fetchSaRateLimit('https://api.coinpaprika.com/v1/tickers?quotes=USD', {}, 'coinpaprika');
        if (!r.ok) return await vratiGresku(r, servis, corsHeaders);
        rezultat = await r.json();
      }
    } else if (servis === 'cryptorank') {
      if (tip === 'pojedinacni') {
        const coinId = idsParam || '1';
        const r = await fetch(`https://api.cryptorank.io/v3/currencies/${coinId}`, { headers: { 'X-Api-Key': env.CRYPTORANK_KEY, 'Accept': 'application/json' } });
        if (!r.ok) return await vratiGresku(r, servis, corsHeaders);
        rezultat = await r.json();
      } else {
        const r = await fetch(`https://api.cryptorank.io/v3/currencies/list`, { headers: { 'X-Api-Key': env.CRYPTORANK_KEY, 'Accept': 'application/json' } });
        if (!r.ok) return await vratiGresku(r, servis, corsHeaders);
        rezultat = await r.json();
      }
    } else if (servis === 'alchemy') {
      const adresa = idsParam || '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
      const r = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [adresa, 'latest'] })
      });
      if (!r.ok) return await vratiGresku(r, servis, corsHeaders);
      rezultat = await r.json();
    }

    let tipZaUpis = tip;
    if (tip === 'pojedinacni' && ids.length > 1) tipZaUpis = 'bulk';
    await zabeleziUpit(env, servis, tipZaUpis, brojElemenata);

    let cenaObracunata = 0;
    if (tipZaUpis === 'bulk') cenaObracunata = Math.ceil(brojElemenata / bulkMax) * (s.cena_bulk || 0);
    else if (tipZaUpis === 'batch') cenaObracunata = s.cena_batch || 0;
    else cenaObracunata = s.cena_pojedinacni || 0;

    return new Response(JSON.stringify({
      ok: true,
      servis,
      tip: tipZaUpis,
      broj_elemenata: brojElemenata,
      bulk_max: bulkMax,
      cena_obracunata: cenaObracunata,
      rezultat
    }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    await zabeleziGresku(env, servis, 'timeout');
    return new Response(JSON.stringify({ error: e.message, servis }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

// ===== EXPORT =====
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    if (url.pathname === "/test") {
      const servis = url.searchParams.get('servis');
      const out = { servis };
      try {
        if (servis === 'meta') { out.meta = await getKriptoMeta(env); out.broj = Object.keys(out.meta).length; }
        else if (servis === 'kes') { const rows = await env.DB.prepare("SELECT * FROM kripto_kes ORDER BY rank LIMIT 10").all(); out.kes = rows.results; }
        else if (servis === 'kes-jedan') { const token = url.searchParams.get('token') || 'btc'; const row = await env.DB.prepare("SELECT * FROM kripto_kes WHERE token=?").bind(token).first(); out.kes = row; }
        else if (servis === 'kes-broj') { const r = await env.DB.prepare("SELECT COUNT(*) as broj FROM kripto_kes").first(); out.broj = r.broj; }
        else if (servis === 'kes-generic') { const rows = await env.DB.prepare("SELECT * FROM kes ORDER BY servis, kljuc").all(); out.kes = rows.results; }
        else if (servis === 'parametri') { const rows = await env.DB.prepare("SELECT * FROM parametri ORDER BY kljuc").all(); out.parametri = rows.results; }
        else if (servis === 'marquee') { out.marquee = await getMarquee(env); }
        else if (servis === 'vreme') { out.belgrade = getBelgradeVreme(); out.utc = new Date().toISOString(); }
        else if (servis === 'servisi') { const rows = await env.DB.prepare("SELECT * FROM servisi ORDER BY naziv").all(); out.servisi = rows.results; }
        else if (servis === 'logoi') {
          const pr = await env.DB.prepare("SELECT COUNT(*) as ukupno FROM kripto_meta WHERE propali = 0").first();
          const sa = await env.DB.prepare("SELECT COUNT(*) as ima FROM kripto_meta WHERE propali = 0 AND logo_lokalno IS NOT NULL AND logo_lokalno != '' AND logo_lokalno != 'Slike/coins/_default.png'").first();
          const def = await env.DB.prepare("SELECT COUNT(*) as ima FROM kripto_meta WHERE propali = 0 AND logo_lokalno = 'Slike/coins/_default.png'").first();
          out.stat = { ukupno: pr.ukupno, sa_pravim_logom: sa.ima, sa_default: def.ima };
        }
        else if (servis === 'locks') { const rows = await env.DB.prepare("SELECT * FROM poslovi_lock").all(); out.locks = rows.results; }
        else if (servis === 'checkpoint') { const rows = await env.DB.prepare("SELECT * FROM kes WHERE servis='checkpoint'").all(); out.checkpoint = rows.results; }
        else if (servis === 'gh-folder') {
          const putanja = url.searchParams.get('putanja') || 'Slike/coins';
          const lista = await getGitHubFolderListSve(env, putanja);
          out.putanja = putanja; out.broj = lista.length; out.imena = lista.slice(0, 15).map(f => f.name);
        }
        else if (servis === 'arhiva') {
          const coinsLista = await getGitHubFolderListSve(env, '0_Arhiva/Coins');
          const dnevnaLista = await getGitHubFolderListSve(env, '0_Arhiva/Dnevna');
          out.coins_broj = coinsLista.length;
          out.dnevna_broj = dnevnaLista.length;
          out.dnevna_imena = dnevnaLista.slice(0, 10).map(f => f.name);
          const cp = await citajCheckpoint(env, 'arhiva'); out.checkpoint = cp;
        }
        else if (servis === 'reports') {
          const lista = await getGitHubFolderListSve(env, '0_Reports');
          out.broj = lista.length;
          out.imena = lista.slice(-10).map(f => f.name);
        }
        else if (servis === 'cs-lista') { const lista = await getCoinstatsList(env); out.broj = lista.length; out.prvi = lista[0]; }
        else if (servis === 'cp-lista') { const lista = await getCpTickeri(env); out.broj = lista.length; out.prvi = lista[0]; }
        else if (servis === 'cg-lista') { const lista = await getCgMarkets(env); out.broj = lista.length; out.prvi = lista[0]; }
        else { out.error = 'Nepoznat servis'; }
      } catch (e) { out.error = e.message; }
      return new Response(JSON.stringify(out, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (url.pathname === "/cron-test") {
      const posao = url.searchParams.get('posao');
      try {
        if (posao === 'kes') { ctx.waitUntil(ciklusKes(env)); return new Response(JSON.stringify({ ok: true, posao: 'kes' }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        else if (posao === 'arhiva') { ctx.waitUntil(posaoArhiva(env)); return new Response(JSON.stringify({ ok: true, posao: 'arhiva' }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        else if (posao === 'meta') { ctx.waitUntil(posaoMeta(env)); return new Response(JSON.stringify({ ok: true, posao: 'meta' }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        else if (posao === 'kurs-fear') { ctx.waitUntil(posaoKursFear(env)); return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        else if (posao === 'logoi') { ctx.waitUntil(posaoLogoi(env)); return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        else if (posao === 'reset-meta-vreme') { await env.DB.prepare("DELETE FROM cron_log WHERE tip='meta'").run(); return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        else if (posao === 'reset-log') { const tip = url.searchParams.get('tip'); const r = await env.DB.prepare("DELETE FROM cron_log WHERE tip=?").bind(tip).run(); return new Response(JSON.stringify({ ok: true, obrisano: r.meta?.changes || 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        else if (posao === 'reset-locks') { await env.DB.prepare("DELETE FROM poslovi_lock").run(); return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        else if (posao === 'reset-checkpoint') { await env.DB.prepare("DELETE FROM kes WHERE servis='checkpoint'").run(); return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        else if (posao === 'log') { const rows = await env.DB.prepare("SELECT * FROM cron_log ORDER BY vreme DESC LIMIT 50").all(); return new Response(JSON.stringify({ log: rows.results }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
        else return new Response(JSON.stringify({ error: 'Nepoznat posao.' }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
    }

    // ===== RUTA: /kes-osvezi (NOVO) =====
    if (url.pathname === "/kes-osvezi") {
      try {
        const lock = await env.DB.prepare("SELECT worker_id, heartbeat FROM poslovi_lock WHERE posao='global'").first();
        if (lock && (Date.now() - lock.heartbeat) < LOCK_MRTAV_MS) {
          return new Response(JSON.stringify({
            ok: false,
            error: 'ciklus vec u toku',
            worker_id: lock.worker_id,
            heartbeat_pre: Math.round((Date.now() - lock.heartbeat) / 1000)
          }, null, 2), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      } catch (e) {}

      const p0 = Date.now();
      ctx.waitUntil((async () => {
        try {
          await ciklusKes(env);
        } catch (e) {
          await logCron(env, 'kes-rucno', 'greska', e.message, Date.now() - p0);
        }
      })());

      return new Response(JSON.stringify({
        ok: true,
        pokrenuto: 'ciklusKes',
        servisi: ['coinstats|coinpaprika', 'coingecko|cryptorank', 'cmc'],
        koraci: ['1:batch', '2:bulk-CG/CR', '3:bulk-CMC', '4:dopuna-CSV', '5:upis-CSV'],
        napomena: 'Rezultat gledaj u /cron-test?posao=log (tip=kes-ciklus)'
      }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (url.pathname === "/watchdog") {
      try { const pokrenut = await pokreniNedovrsen(env); return new Response(JSON.stringify({ ok: true, pokrenut }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
    }

    if (url.pathname === "/upit") { return await rutaUpit(env, url, corsHeaders); }
    if (url.pathname === "/coingecko-map-download") { return await rutaCoingeckoMapDownload(env, corsHeaders); }
    if (url.pathname === "/coinstats-map-download") { return await rutaCoinstatsMapDownload(env, corsHeaders); }
    if (url.pathname === "/cryptorank-map-download") { return await rutaCryptorankMapDownload(env, corsHeaders); }
    if (url.pathname === "/coinpaprika-map-download") { return await rutaCoinpaprikaMapDownload(env, corsHeaders); }
    if (url.pathname === "/coingecko-mapiraj") { return await rutaCoingeckoMapiraj(env, corsHeaders); }
    if (url.pathname === "/coinstats-mapiraj") { return await rutaCoinstatsMapiraj(env, corsHeaders); }
    if (url.pathname === "/cryptorank-mapiraj") { return await rutaCryptorankMapiraj(env, corsHeaders); }
    if (url.pathname === "/coinpaprika-mapiraj") { return await rutaCoinpaprikaMapiraj(env, corsHeaders); }
    if (url.pathname === "/provera_mapiranosti") { return await rutaProveraMapiranosti(env, corsHeaders); }
    if (url.pathname === "/cs-test2") { return await rutaCsTest2(env, url, corsHeaders); }
    if (url.pathname === "/cr-test2") { return await rutaCrTest2(env, url, corsHeaders); }
    if (url.pathname === "/cg-test") { return await rutaCgTest(env, url, corsHeaders); }

    if (url.pathname === "/krediti") {
      try {
        const [cmc, coinstats, alchemy, cryptorank] = await Promise.all([
          osveziKrediteCMC(env),
          osveziKrediteCoinStats(env),
          osveziKrediteAlchemy(env),
          osveziKrediteCryptorank(env)
        ]);
        return new Response(JSON.stringify({ ok: true, cmc, coinstats, alchemy, cryptorank }, null, 2), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/cr-test") {
      const KEY = env.CRYPTORANK_KEY;
      if (!KEY) return new Response(JSON.stringify({ error: 'nema CRYPTORANK_KEY' }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      try {
        const r = await fetch(`https://api.cryptorank.io/v3/status`, {
          headers: { 'X-Api-Key': KEY, 'Accept': 'application/json' }
        });
        const svi = {};
        r.headers.forEach((v, k) => { svi[k] = v; });
        let body = null;
        try { body = await r.json(); } catch (e) { body = await r.text(); }
        return new Response(JSON.stringify({
          status: r.status,
          statusText: r.statusText,
          headers: svi,
          body_prvih_500: typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)
        }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/marquee") {
      try { return new Response(JSON.stringify(await getMarquee(env)), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
    }

    if (url.pathname === "/liste") {
      const period = url.searchParams.get('period') || '24h';
      const tip = url.searchParams.get('tip') || 'gainers';
      const limit = parseInt(url.searchParams.get('limit') || '5', 10);
      const meta = await getKriptoMeta(env);
      const rezultat = [];
      try {
        if (period === '1h' || period === '12h' || period === '24h') {
          const kolona = period === '1h' ? 'pr_cena_1h' : period === '12h' ? 'pr_cena_12h' : 'pr_cena_24h';
          const rows = await env.DB.prepare(`SELECT token, cena, ${kolona} as promena FROM kripto_kes WHERE ${kolona} IS NOT NULL`).all();
          for (const r of rows.results) {
            const m = meta[r.token]; if (!m || m.je_stablecoin) continue;
            rezultat.push({ simbol: r.token, naziv: m.naziv, cena: r.cena, promena: r.promena, cmc_slug: m.cmc_slug, logo: m.logo_lokalno || 'Slike/coins/_default.png' });
          }
        } else if (period === 'volumen_skok' || period === 'volumen_pad') {
          const rows = await env.DB.prepare("SELECT token, cena, pr_vol_24h as promena FROM kripto_kes WHERE pr_vol_24h IS NOT NULL").all();
          for (const r of rows.results) {
            const m = meta[r.token]; if (!m || m.je_stablecoin) continue;
            rezultat.push({ simbol: r.token, naziv: m.naziv, cena: r.cena, promena: r.promena, cmc_slug: m.cmc_slug, logo: m.logo_lokalno || 'Slike/coins/_default.png' });
          }
        } else {
          const mapa = { '7d': 'pr_cena_7d', '14d': 'pr_cena_14d', '30d': 'pr_cena_30d', '60d': 'pr_cena_60d', '90d': 'pr_cena_90d' };
          const kolona = mapa[period];
          if (!kolona) return new Response(JSON.stringify({ error: 'nepoznat period' }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          const rows = await env.DB.prepare(`SELECT token, cena, ${kolona} as promena FROM kripto_kes WHERE ${kolona} IS NOT NULL`).all();
          for (const r of rows.results) {
            const m = meta[r.token]; if (!m || m.je_stablecoin) continue;
            rezultat.push({ simbol: r.token, naziv: m.naziv, cena: r.cena, promena: r.promena, cmc_slug: m.cmc_slug, logo: m.logo_lokalno || 'Slike/coins/_default.png' });
          }
        }
        let filtrirano;
        if (tip === 'gainers') { filtrirano = rezultat.filter(x => x.promena > 0).sort((a, b) => b.promena - a.promena); }
        else if (tip === 'losers') { filtrirano = rezultat.filter(x => x.promena < 0).sort((a, b) => a.promena - b.promena); }
        else filtrirano = rezultat;
        return new Response(JSON.stringify({ period, tip, lista: filtrirano.slice(0, limit) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
    }

    if (url.pathname === "/volumen") {
      const period = url.searchParams.get('period') || '24h';
      const limit = parseInt(url.searchParams.get('limit') || '10', 10);
      const mapa = {
        '1h': 'pr_vol_1h',
        '6h': 'pr_vol_6h',
        '12h': 'pr_vol_12h',
        '24h': 'pr_vol_24h',
        '7d': 'pr_vol_7d',
        '14d': 'pr_vol_14d',
        '30d': 'pr_vol_30d',
        '60d': 'pr_vol_60d',
        '90d': 'pr_vol_90d'
      };
      const kolona = mapa[period];
      if (!kolona) return new Response(JSON.stringify({ error: 'nepoznat period' }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      try {
        const meta = await getKriptoMeta(env);
        const rows = await env.DB.prepare(`SELECT token, cena, ${kolona} as promena FROM kripto_kes WHERE ${kolona} IS NOT NULL`).all();
        const rezultat = [];
        for (const r of rows.results) {
          const m = meta[r.token];
          if (!m || m.je_stablecoin) continue;
          rezultat.push({
            simbol: r.token,
            naziv: m.naziv,
            cena: r.cena,
            promena: r.promena,
            cmc_slug: m.cmc_slug,
            logo: m.logo_lokalno || 'Slike/coins/_default.png'
          });
        }
        const gainers = rezultat.filter(x => x.promena > 0).sort((a, b) => b.promena - a.promena).slice(0, limit);
        const losers = rezultat.filter(x => x.promena < 0).sort((a, b) => a.promena - b.promena).slice(0, limit);
        return new Response(JSON.stringify({ period, gainers, losers }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/istorija") {
      const token = (url.searchParams.get('token') || '').toLowerCase().trim();
      const danaParam = url.searchParams.get('dana') || '30';
      if (!token) return new Response(JSON.stringify({ error: 'nema token' }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      try {
        const p = await getParametri(env);
        const ttl = parseInt(p['ttl_arhiva_token_sek'] || '21600', 10) * 1000;

        try {
          const kes = await env.DB.prepare("SELECT podaci, vreme FROM kes WHERE servis='arhiva-token' AND kljuc=?").bind(token).first();
          if (kes && kes.podaci && (Date.now() - kes.vreme) < ttl) {
            const sadrzaj = JSON.parse(kes.podaci);
            return new Response(JSON.stringify(pripremiIstoriju(sadrzaj, danaParam)), {
              headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "HIT" }
            });
          }
        } catch (e) {}

        const rez = await getGitHubFajlSaSadrzajem(env, `0_Arhiva/Coins/${token}.json`);
        if (!rez.postoji || !rez.sadrzaj) {
          return new Response(JSON.stringify({ error: 'nema arhive za token', token }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        try {
          await env.DB.prepare("INSERT OR REPLACE INTO kes (servis, kljuc, podaci, vreme) VALUES ('arhiva-token', ?, ?, ?)")
            .bind(token, JSON.stringify(rez.sadrzaj), Date.now()).run();
        } catch (e) {}

        return new Response(JSON.stringify(pripremiIstoriju(rez.sadrzaj, danaParam)), {
          headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "MISS" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    if (url.pathname === "/odrzivost") {
      const ids = url.searchParams.get('ids');
      if (!ids) return new Response(JSON.stringify({ error: 'nema ids' }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const sviIds = ids.split(',').map(s => s.trim());
      const meta = await getKriptoMeta(env);
      const servisiSortirani = await getServisiSortirani(env);
      const maxOdr = servisiSortirani.length > 0 ? servisiSortirani[0].odrzivost : null;
      const rezultat = {}; const cgTrebaPozvati = []; const cmcTrebaPozvati = [];
      for (const id of sviIds) {
        let simbol = null;
        if (id.startsWith('cmc:')) simbol = nadjiSimbolPoCmcuId(meta, id.slice(4));
        else simbol = nadjiSimbolPoCgId(meta, id);
        if (simbol) { const ttl = await ttlZaToken(env, simbol, maxOdr); const izD1 = await getCenaIzD1(env, simbol, ttl); if (izD1) { rezultat[id] = { usd: izD1.cena }; continue; } }
        if (id.startsWith('cmc:')) cmcTrebaPozvati.push(id.slice(4)); else cgTrebaPozvati.push(id);
      }
      let izvor = null;
      if (cgTrebaPozvati.length) {
        for (const servis of servisiSortirani) {
          const naziv = servis.naziv;
          if (naziv !== 'cmc' && naziv !== 'coinstats' && naziv !== 'coingecko') continue;
          if (uToku[naziv]) { const slobodan = await cekajUToku(naziv, 2000); if (!slobodan) continue; }
          uToku[naziv] = true;
          try {
            const batch = cgTrebaPozvati;
            let r = null;
            if (naziv === 'cmc') {
              const idMap = {}; for (const [, i] of Object.entries(meta)) idMap[i.coingecko] = i.cmc;
              const ids = batch.map(c => idMap[c]).filter(x => x);
              if (ids.length) {
                const resp = await fetchSaRateLimit(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?id=${ids.join(',')}&convert=USD&skip_invalid=true&CMC_PRO_API_KEY=${env.CMC_API_KEY}`, {}, 'cmc');
                if (resp.ok) {
                  const d = await resp.json();
                  const lista = Object.values(d.data || {});
                  r = {}; const upisi = [];
                  for (const info of lista) {
                    const cc = parseFloat(info.quote?.USD?.price);
                    if (!cc) continue;
                    const s = nadjiSimbolPoCmcuId(meta, info.id);
                    if (!s) continue;
                    r[s] = { usd: cc };
                    upisi.push({ simbol: s, cena: cc, rank: info.cmc_rank || null, ...mapirajCMC(info.quote.USD, info.cmc_rank) });
                  }
                  await upisiCeneBulk(env, upisi, 'cmc');
                  ctx.waitUntil(zabeleziUpit(env, 'cmc', ids.length > 1 ? 'bulk' : 'pojedinacni', ids.length));
                }
              }
            } else if (naziv === 'coinstats') {
              const lista = await getCoinstatsList(env);
              r = {}; const upisi = [];
              for (const c of lista) {
                for (const cgId of batch) {
                  if (r[cgId]) continue;
                  if (c.id === cgId || c.slug === cgId) {
                    r[cgId] = { usd: parseFloat(c.price) };
                    const s = nadjiSimbolPoCgId(meta, cgId);
                    if (s) upisi.push({ simbol: s, cena: parseFloat(c.price), ...mapirajCS(c) });
                  }
                }
              }
              await upisiCeneBulk(env, upisi, 'coinstats');
            } else if (naziv === 'coingecko') {
              const url2 = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${batch.join(',')}&price_change_percentage=1h,24h,7d,14d,30d,200d,1y&sparkline=false`;
              const resp = await fetchSaRateLimit(url2, { headers: { 'x-cg-demo-api-key': env.COINGEKO_KEY, 'Accept': 'application/json' } }, 'coingecko');
              if (resp.ok) {
                const d = await resp.json();
                r = {}; const upisi = [];
                for (const c of (Array.isArray(d) ? d : [])) {
                  if (typeof c.current_price !== 'number') continue;
                  r[c.id] = { usd: c.current_price };
                  const s = nadjiSimbolPoCgId(meta, c.id);
                  if (s) upisi.push({ simbol: s, cena: c.current_price, ...mapirajCG(c) });
                }
                await upisiCeneBulk(env, upisi, 'coingecko');
                ctx.waitUntil(zabeleziUpit(env, 'coingecko', batch.length > 1 ? 'bulk' : 'pojedinacni', batch.length));
              }
            }
            if (r) { izvor = naziv; for (const k of Object.keys(r)) rezultat[k] = r[k]; break; }
          } finally { uToku[naziv] = false; }
        }
      }
      if (cmcTrebaPozvati.length) {
        if (uToku['cmc']) await cekajUToku('cmc', 2000);
        uToku['cmc'] = true;
        try {
          const resp = await fetchSaRateLimit(`https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?id=${cmcTrebaPozvati.join(',')}&convert=USD&skip_invalid=true&CMC_PRO_API_KEY=${env.CMC_API_KEY}`, {}, 'cmc');
          if (resp.ok) {
            const d = await resp.json();
            const lista = Object.values(d.data || {});
            const upisi = [];
            for (const info of lista) {
              const cc = parseFloat(info.quote?.USD?.price);
              if (!cc) continue;
              rezultat[`cmc:${info.id}`] = { usd: cc };
              const s = nadjiSimbolPoCmcuId(meta, info.id);
              if (s) upisi.push({ simbol: s, cena: cc, rank: info.cmc_rank || null, ...mapirajCMC(info.quote.USD, info.cmc_rank) });
            }
            await upisiCeneBulk(env, upisi, 'cmc');
            izvor = izvor ? (izvor + '+cmc') : 'cmc';
            ctx.waitUntil(zabeleziUpit(env, 'cmc', cmcTrebaPozvati.length > 1 ? 'bulk' : 'pojedinacni', cmcTrebaPozvati.length));
          }
        } finally { uToku['cmc'] = false; }
      }
      if (!Object.keys(rezultat).length) return new Response(JSON.stringify({ error: 'Nijedan servis nije vratio' }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ izvor: izvor || 'D1', ...rezultat }), { headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": izvor || 'D1-HIT' } });
    }

    if (url.pathname === "/kurs") {
      const p = await getParametri(env);
      const ttlKes = parseInt(p['ttl_nbs_sek'] || '86400', 10) * 1000;
      try { const kes = await env.DB.prepare("SELECT podaci, vreme FROM kes WHERE servis='allrates' AND kljuc='nbs_danas'").first(); if (kes && kes.podaci !== '{}' && (Date.now() - kes.vreme) < ttlKes) return new Response(kes.podaci, { headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "HIT" } }); } catch (e) {}
      uToku['kurs'] = true;
      try { const kurs = await getKurs(env); if (!kurs) return new Response(JSON.stringify({ error: 'Kurs nedostupan' }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }); const odg = JSON.stringify(kurs); try { await env.DB.prepare("UPDATE kes SET podaci=?, vreme=? WHERE servis='allrates' AND kljuc='nbs_danas'").bind(odg, Date.now()).run(); } catch (e) {} return new Response(odg, { headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "MISS" } }); }
      catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      finally { uToku['kurs'] = false; }
    }

    if (url.pathname === "/gas") {
      const p = await getParametri(env);
      const ttlKes = parseInt(p['ttl_gas_eth_sek'] || '12', 10) * 1000;
      try { const kes = await env.DB.prepare("SELECT podaci, vreme FROM kes WHERE servis='etherscan' AND kljuc='gas_eth'").first(); if (kes && kes.podaci !== '{}' && (Date.now() - kes.vreme) < ttlKes) return new Response(kes.podaci, { headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "HIT" } }); } catch (e) {}
      uToku['gas'] = true;
      try {
        const KEY = env.ETHERSCAN_KEY; if (!KEY) return new Response(JSON.stringify({ error: 'nema Etherscan' }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const r = await fetchSaRateLimit(`https://api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle&apikey=${KEY}`, {}, 'etherscan');
        const d = await r.json();
        ctx.waitUntil(zabeleziUpit(env, 'etherscan', 'pojedinacni'));
        const odg = JSON.stringify({ gas: d }); try { await env.DB.prepare("UPDATE kes SET podaci=?, vreme=? WHERE servis='etherscan' AND kljuc='gas_eth'").bind(odg, Date.now()).run(); } catch (e) {}
        return new Response(odg, { headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "MISS" } });
      } catch (e) { await zabeleziGresku(env, 'etherscan', 'timeout'); return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      finally { uToku['gas'] = false; }
    }

    if (url.pathname === "/fear") {
      const p = await getParametri(env);
      const ttlKes = parseInt(p['ttl_fear_greed_sek'] || '86400', 10) * 1000;
      try { const kes = await env.DB.prepare("SELECT podaci, vreme FROM kes WHERE servis='cmc' AND kljuc='fear_greed'").first(); if (kes && kes.podaci !== '{}' && (Date.now() - kes.vreme) < ttlKes) return new Response(kes.podaci, { headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "HIT" } }); } catch (e) {}
      uToku['fear'] = true;
      try {
        const KEY = env.CMC_API_KEY; if (!KEY) return new Response(JSON.stringify({ error: 'nema CMC' }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        const r = await fetchSaRateLimit('https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest', { headers: { 'X-CMC_PRO_API_KEY': KEY } }, 'cmc');
        const d = await r.json();
        ctx.waitUntil(zabeleziUpit(env, 'cmc', 'pojedinacni'));
        const odg = JSON.stringify(d); try { await env.DB.prepare("UPDATE kes SET podaci=?, vreme=? WHERE servis='cmc' AND kljuc='fear_greed'").bind(odg, Date.now()).run(); } catch (e) {}
        return new Response(odg, { headers: { ...corsHeaders, "Content-Type": "application/json", "X-Cache": "MISS" } });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      finally { uToku['fear'] = false; }
    }

    if (url.pathname === "/balance") {
      const BS = env.BLOCKSCOUT_API_KEY;
      if (!BS) return new Response(JSON.stringify({ error: 'nema Blockscout' }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const address = url.searchParams.get('address'); const contract = url.searchParams.get('contract');
      if (!address) return new Response(JSON.stringify({ error: 'nema address' }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const target = contract ? `https://api.blockscout.com/v2/api?chain_id=1&module=account&action=tokenbalance&contractaddress=${contract}&address=${address}&tag=latest&apikey=${BS}` : `https://api.blockscout.com/v2/api?chain_id=1&module=account&action=balance&address=${address}&tag=latest&apikey=${BS}`;
      try {
        const r = await fetchSaRateLimit(target, {}, 'blockscout');
        const d = await r.json();
        ctx.waitUntil(zabeleziUpit(env, 'blockscout', 'pojedinacni'));
        const meta = await getKriptoMeta(env);
        let sZaCenu = contract ? nadjiSimbolPoContract(meta, contract) : 'eth'; let cenaUsd = null;
        if (sZaCenu) { const ttl = await ttlZaToken(env, sZaCenu, null); const izD1 = await getCenaIzD1(env, sZaCenu, ttl); if (izD1) cenaUsd = izD1.cena; }
        return new Response(JSON.stringify(Object.assign({}, d, { cena_usd: cenaUsd, simbol: sZaCenu })), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) { await zabeleziGresku(env, 'blockscout', 'timeout'); return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
    }

    if (url.pathname === "/save-balans") {
      try { const a = url.searchParams.get('adresa'), t = url.searchParams.get('token'), b = url.searchParams.get('balans'), bu = url.searchParams.get('balans_usd'); if (!a || !t || !b) return new Response(JSON.stringify({ error: 'nema parametara' }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }); await env.DB.prepare("INSERT INTO balans_history (adresa, token, balans, balans_usd, vreme) VALUES (?, ?, ?, ?, ?)").bind(a, t, b, bu ? parseFloat(bu) : null, Date.now()).run(); return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
    }

    if (url.pathname === "/get-balans") {
      try { const a = url.searchParams.get('adresa'), t = url.searchParams.get('token'); const row = await env.DB.prepare("SELECT balans, balans_usd, vreme FROM balans_history WHERE adresa=? AND token=? ORDER BY vreme DESC LIMIT 1").bind(a, t).first(); return new Response(JSON.stringify({ ok: true, podaci: row || null }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
    }

    if (url.pathname === "/email-treba") {
      try { const tip = url.searchParams.get('tip') || 'gas'; const cd = parseInt(url.searchParams.get('cooldown') || '20', 10); const row = await env.DB.prepare("SELECT vreme FROM email_log WHERE tip=? ORDER BY vreme DESC LIMIT 1").bind(tip).first(); if (!row) return new Response(JSON.stringify({ treba: true, razlog: 'nema prethodnog' }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); const treba = row.vreme < (Date.now() - cd * 60000); const pre = treba ? 0 : Math.ceil((row.vreme + cd * 60000 - Date.now()) / 60000); return new Response(JSON.stringify({ treba, zadnji: row.vreme, preostalo_min: pre }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
    }

    if (url.pathname === "/email-zabelezi") {
      try { const tip = url.searchParams.get('tip') || 'gas'; await env.DB.prepare("INSERT INTO email_log (tip, vreme) VALUES (?, ?)").bind(tip, Date.now()).run(); return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
    }

    if (url.pathname === "/servisi-test") {
      try { const svi = await getServisiSortirani(env); return new Response(JSON.stringify({ sortirano: svi.map(s => ({ naziv: s.naziv, odrzivost: s.odrzivost !== null ? parseFloat(s.odrzivost.toFixed(2)) : null, preostalo_kredita: s.preostalo_kredita, utroseno_kredita: s.utroseno_kredita, limit: s.limit_kredita, period: s.period, period_kraj: s.period_kraj })) }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
    }

    if (url.pathname === "/db-test") {
      try { const r = await env.DB.prepare("SELECT 1 as ok").first(); return new Response(JSON.stringify({ d1: r }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
      catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
    }

    return new Response(JSON.stringify({ info: "Kripto proxy", routes: ["/test?servis=X", "/cron-test?posao=X", "/kes-osvezi", "/watchdog", "/upit?servis=X&tip=Y", "/krediti", "/cr-test", "/cr-test2?path=/v3/...", "/cs-test2?path=...", "/cg-test", "/coingecko-map-download", "/coinstats-map-download", "/cryptorank-map-download", "/coinpaprika-map-download", "/coingecko-mapiraj", "/coinstats-mapiraj", "/cryptorank-mapiraj", "/coinpaprika-mapiraj", "/provera_mapiranosti", "/marquee", "/liste", "/volumen?period=X", "/istorija?token=X&dana=Y", "/odrzivost?ids=...", "/kurs", "/gas", "/fear", "/balance", "/servisi-test", "/db-test"] }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  },

  async scheduled(controller, env, ctx) {
    const cronExpr = controller.cron;

    if (cronExpr === "* * * * *") {
      ctx.waitUntil((async () => {
        try {
          const p = await getParametri(env);
          const intervalSek = parseInt(p['kes_interval_sek'] || '900', 10);
          const zadnji = await env.DB.prepare("SELECT MAX(vreme) as v FROM kripto_kes").first();
          const proteklo = (zadnji && zadnji.v) ? (Date.now() - zadnji.v) : Infinity;
          if (proteklo >= intervalSek * 1000 - 60000) {
            await ciklusKes(env);
          }
        } catch (e) {
          await logCron(env, 'ciklus-kes', 'greska', e.message, 0);
        }
      })());
    } else if (cronExpr === "15,45 * * * *") {
      ctx.waitUntil((async () => {
        await pokreniNedovrsen(env);
      })());
    } else if (cronExpr === "45 23 * * *") {
      ctx.waitUntil((async () => {
        await posaoArhiva(env);
        await pokreniNedovrsen(env);
      })());
    } else if (cronExpr === "30 6,7 * * *") {
      const bv = getBelgradeVreme();
      if (bv.hh === 8 && bv.mm >= 30 && bv.mm < 45) ctx.waitUntil(posaoKursFear(env));
    }
  }
};

// ===== KRAJ DEO 7/7 =====