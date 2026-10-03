const PER_PAGE = 40;
const RAW = 'https://raw.githubusercontent.com/DenMartinCom/sajt-u-izradi/main';
const API = 'https://cmc-proxy.martin-denic.workers.dev';

const MARK_KEY_PREFIX = 'provera_mark_';
const RECENT_MS = 24 * 60 * 60 * 1000;

const state = {
  aktivniTab: 'cg',           // 'cg' | 'cs'
  mark: { cg: {}, cs: {} },   // { [cmc_id]: { target, ts } }
  obelezeni: { cg: new Set(), cs: new Set() },
  cmcIndex: {},
  cgIndex: {},
  csIndex: {},                // keyed po id
  tokens: [],                 // [{simbol, cmc, cg, cs}]
  prikazani: [],
  strana: 0,
  sortiranje: 'nedavno',
  samo24h: false
};

// ===== localStorage =====
function ucitajMark(tab) {
  try {
    const raw = localStorage.getItem(MARK_KEY_PREFIX + tab);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
  } catch (e) { return {}; }
}

function sacuvajMark(tab) {
  try { localStorage.setItem(MARK_KEY_PREFIX + tab, JSON.stringify(state.mark[tab])); } catch (e) {}
}

function oznaci(cmc, target) {
  const tab = state.aktivniTab;
  state.mark[tab][String(cmc)] = { target: target || null, ts: Date.now() };
  sacuvajMark(tab);
}

// ===== fetch =====
async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + url);
  return r.json();
}

// ===== URL / LINK helperi =====
function urlCmc(cmcId) {
  return `https://s2.coinmarketcap.com/static/img/coins/64x64/${cmcId}.png`;
}

function urlCg(zapis) {
  if (!zapis || !zapis.logo || typeof zapis.logo !== 'object') return null;
  if (zapis.logo.id == null || !zapis.logo.file) return null;
  return `https://assets.coingecko.com/coins/images/${zapis.logo.id}/large/${zapis.logo.file}`;
}

function urlCs(zapis) {
  if (!zapis || !zapis.logo) return null;
  if (typeof zapis.logo !== 'string' || !zapis.logo.length) return null;
  return `https://static.coinstats.app/coins/${zapis.logo}`;
}

function linkZaKarticu(zapis, tip) {
  if (!zapis) return null;
  if (tip === 'cmc') {
    if (!zapis.slug) return null;
    return `https://coinmarketcap.com/currencies/${zapis.slug}/`;
  }
  if (tip === 'cg') {
    if (!zapis.id) return null;
    return `https://www.coingecko.com/en/coins/${zapis.id}`;
  }
  if (tip === 'cs') {
    if (!zapis.slug) return null;
    return `https://coinstats.app/coins/${zapis.slug}`;
  }
  return null;
}

// ===== KARTICA =====
function napraviKarticu(zapis, tip) {
  const el = document.createElement('div');
  el.className = 'kartica ' + tip;

  const ime = document.createElement('div');
  ime.className = 'ime';

  const img = document.createElement('img');
  img.className = 'logo';
  img.alt = '';
  img.loading = 'lazy';
  img.style.visibility = 'hidden';

  const simbol = document.createElement('div');
  simbol.className = 'simbol';

  if (!zapis) {
    el.classList.add('prazno');
    ime.textContent = '/';
    simbol.textContent = '/';
  } else {
    const tekst = zapis.name || '/';
    const link = linkZaKarticu(zapis, tip);
    if (link) {
      const a = document.createElement('a');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = tekst;
      ime.appendChild(a);
    } else {
      ime.textContent = tekst;
    }
    simbol.textContent = zapis.symbol || '/';

    const url = tip === 'cmc' ? urlCmc(zapis.id) : (tip === 'cg' ? urlCg(zapis) : urlCs(zapis));
    if (url) {
      img.src = url;
      img.onload = () => { img.style.visibility = 'visible'; };
    }
  }

  el.appendChild(ime);
  el.appendChild(img);
  el.appendChild(simbol);
  return el;
}

// ===== DOHVAT DESNOG ZAPISA =====
function desniZapis(t) {
  if (state.aktivniTab === 'cg') {
    return t.cg ? state.cgIndex[String(t.cg)] : null;
  }
  return t.cs ? state.csIndex[String(t.cs)] : null;
}

function desniTargetId(t) {
  if (state.aktivniTab === 'cg') return t.cg;
  return t.cs;
}

// ===== SORTIRANJE / FILTRIRANJE =====
function pripremiPrikaz() {
  const tab = state.aktivniTab;
  const mark = state.mark[tab];
  let l = state.tokens.slice();

  if (state.samo24h) {
    const granica = Date.now() - RECENT_MS;
    l = l.filter(t => {
      const m = mark[String(t.cmc)];
      return m && m.ts && m.ts >= granica;
    });
  }

  if (state.sortiranje === 'simbol') {
    l.sort((a, b) => String(a.simbol).localeCompare(String(b.simbol)));
  } else if (state.sortiranje === 'nedavno') {
    l.sort((a, b) => {
      const ma = mark[String(a.cmc)];
      const mb = mark[String(b.cmc)];
      const ta = (ma && ma.ts) ? ma.ts : 0;
      const tb = (mb && mb.ts) ? mb.ts : 0;
      return tb - ta;
    });
  }

  state.prikazani = l;
  state.strana = 0;
}

// ===== RENDER =====
function render() {
  const lista = document.getElementById('lista');
  lista.innerHTML = '';

  const tab = state.aktivniTab;
  const mark = state.mark[tab];
  const obelezeni = state.obelezeni[tab];

  const start = state.strana * PER_PAGE;
  const end = Math.min(start + PER_PAGE, state.prikazani.length);

  for (let i = start; i < end; i++) {
    const t = state.prikazani[i];
    const red = document.createElement('div');
    red.className = 'red';

    const m = mark[String(t.cmc)];
    if (m && m.ts) {
      if ((Date.now() - m.ts) < RECENT_MS) red.classList.add('mark-recent');
      else red.classList.add('mark-staro');
    }

    const cek = document.createElement('div');
    cek.className = 'cek';
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = obelezeni.has(String(t.cmc));
    inp.dataset.cmc = String(t.cmc);
    inp.addEventListener('change', () => {
      if (inp.checked) {
        obelezeni.add(String(t.cmc));
        const target = desniTargetId(t);
        if (target) oznaci(t.cmc, target);
      } else {
        obelezeni.delete(String(t.cmc));
      }
      azurirajInfo();
    });
    cek.appendChild(inp);

    const cmcZapis = t.cmc != null ? state.cmcIndex[String(t.cmc)] : null;
    const dZapis = desniZapis(t);

    red.appendChild(cek);
    red.appendChild(napraviKarticu(cmcZapis, 'cmc'));
    red.appendChild(napraviKarticu(dZapis, tab));
    lista.appendChild(red);
  }

  const ukupnoStrana = Math.max(1, Math.ceil(state.prikazani.length / PER_PAGE));
  document.getElementById('strana').textContent = `${state.strana + 1} / ${ukupnoStrana}`;
  document.getElementById('pre').disabled = state.strana === 0;
  document.getElementById('sle').disabled = state.strana >= ukupnoStrana - 1;
  azurirajInfo();
}

function azurirajInfo() {
  const sve = state.tokens.length;
  const prik = state.prikazani.length;
  const ob = state.obelezeni[state.aktivniTab].size;
  const deo = (prik === sve) ? `${sve} tokena` : `${prik}/${sve} tokena`;
  document.getElementById('info').textContent = `${deo} | čekirano: ${ob}`;
}

// ===== START =====
async function pokreni() {
  const info = document.getElementById('info');
  try {
    state.mark.cg = ucitajMark('cg');
    state.mark.cs = ucitajMark('cs');

    info.textContent = 'Meta...';
    const m = await fetchJson(`${API}/test?servis=meta`);
    const meta = m.meta || {};

    info.textContent = 'CMC mapa...';
    const cmcArr = await fetchJson(`${RAW}/0_Arhiva/Mape/d_coinmarketcap_map.json`);
    state.cmcIndex = {};
    if (Array.isArray(cmcArr)) for (const z of cmcArr) if (z.id != null) state.cmcIndex[String(z.id)] = z;

    info.textContent = 'CG mapa...';
    const cgArr = await fetchJson(`${RAW}/0_Arhiva/Mape/d_coingecko_map.json`);
    state.cgIndex = {};
    if (Array.isArray(cgArr)) for (const z of cgArr) if (z.id != null) state.cgIndex[String(z.id)] = z;

    info.textContent = 'CS mapa...';
    const csArr = await fetchJson(`${RAW}/0_Arhiva/Mape/c_coinstats_map.json`);
    state.csIndex = {};
    if (Array.isArray(csArr)) for (const z of csArr) {
      if (z.id && !state.csIndex[String(z.id)]) state.csIndex[String(z.id)] = z;
    }

    state.tokens = [];
    for (const [simbol, i] of Object.entries(meta)) {
      if (i.cmc == null) continue;
      state.tokens.push({
        simbol,
        cmc: i.cmc,
        cg: i.coingecko || null,
        cs: i.coinstats_id || null
      });
    }

    inicijalizujObelezene();
    pripremiPrikaz();
    azurirajZaglavlje();
    render();
  } catch (e) {
    info.textContent = 'Greška: ' + e.message;
    console.error(e);
  }
}

function inicijalizujObelezene() {
  state.obelezeni.cg = new Set();
  state.obelezeni.cs = new Set();
  for (const t of state.tokens) {
    if (t.cg == null) state.obelezeni.cg.add(String(t.cmc));
    if (t.cs == null) state.obelezeni.cs.add(String(t.cmc));
  }
}

// ===== TAB =====
function prebaciTab(tab) {
  state.aktivniTab = tab;
  state.strana = 0;

  document.querySelectorAll('.tab').forEach(el => {
    el.classList.toggle('aktivan', el.dataset.tab === tab);
  });

  azurirajZaglavlje();
  pripremiPrikaz();
  render();
}

function azurirajZaglavlje() {
  document.getElementById('desnoZaglavlje').textContent = state.aktivniTab.toUpperCase();
}

// ===== GENERIŠI =====
async function generisi() {
  const tab = state.aktivniTab;
  const ob = state.obelezeni[tab];
  if (!ob.size) { alert('Nema obeleženih.'); return; }

  const parovi = [];
  for (const t of state.tokens) {
    if (!ob.has(String(t.cmc))) continue;
    const target = tab === 'cg' ? (t.cg || null) : (t.cs || null);
    parovi.push({ cmc: t.cmc, target });
  }

  try {
    const r = await fetch(`${API}/provera-sacuvaj?servis=${tab}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parovi })
    });
    const d = await r.json();
    if (d && d.ok) {
      alert(`Sačuvano ${d.broj} parova (${tab.toUpperCase()})`);
      state.obelezeni[tab] = new Set();
      render();
    } else {
      alert('Greška: ' + (d && d.greska ? d.greska : 'nepoznato'));
    }
  } catch (e) {
    alert('Greška: ' + e.message);
  }
}

// ===== NL — bez logotipa =====
async function generisiNemaLogo() {
  const tab = state.aktivniTab;
  const ids = [];

  for (const t of state.tokens) {
    if (tab === 'cg') {
      if (!t.cg) continue;
      const zapis = state.cgIndex[String(t.cg)];
      if (!zapis) continue;
      const ima = zapis.logo && typeof zapis.logo === 'object' && zapis.logo.id != null && zapis.logo.file;
      if (!ima) ids.push(t.cg);
    } else {
      if (!t.cs) continue;
      const zapis = state.csIndex[String(t.cs)];
      if (!zapis) continue;
      const logo = zapis.logo;
      const ima = logo && typeof logo === 'string' && logo.length > 0;
      if (!ima) ids.push(t.cs);
    }
  }

  if (!ids.length) { alert('Svi tokeni imaju logo.'); return; }

  try {
    const r = await fetch(`${API}/nema-logo-sacuvaj?servis=${tab}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    const tekst = await r.text();
    console.log('NL status:', r.status, 'body:', tekst.slice(0, 500));
    if (!r.ok) { alert('HTTP ' + r.status + ': ' + tekst.slice(0, 200)); return; }
    let d;
    try { d = JSON.parse(tekst); } catch (e) { alert('Nije JSON: ' + tekst.slice(0, 200)); return; }
    if (d && d.ok) alert(`Sačuvano ${d.broj} id-jeva bez logotipa (${tab.toUpperCase()})`);
    else alert('Greška: ' + (d && d.greska ? d.greska : JSON.stringify(d).slice(0, 200)));
  } catch (e) {
    alert('Mreža: ' + e.message);
  }
}

// ===== LISTENERI =====
document.getElementById('tab-cg').addEventListener('click', () => prebaciTab('cg'));
document.getElementById('tab-cs').addEventListener('click', () => prebaciTab('cs'));

document.getElementById('pre').addEventListener('click', () => {
  if (state.strana > 0) { state.strana--; render(); }
});
document.getElementById('sle').addEventListener('click', () => {
  const ukupno = Math.ceil(state.prikazani.length / PER_PAGE);
  if (state.strana < ukupno - 1) { state.strana++; render(); }
});
document.getElementById('reset').addEventListener('click', () => {
  state.obelezeni[state.aktivniTab] = new Set();
  render();
});
document.getElementById('gen').addEventListener('click', generisi);
document.getElementById('nologo').addEventListener('click', generisiNemaLogo);
document.getElementById('reload').addEventListener('click', pokreni);

document.getElementById('sort').addEventListener('change', (e) => {
  state.sortiranje = e.target.value;
  pripremiPrikaz();
  render();
});

document.getElementById('filter24h').addEventListener('change', (e) => {
  state.samo24h = e.target.checked;
  pripremiPrikaz();
  render();
});

pokreni();