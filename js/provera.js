const PER_PAGE = 40;
const RAW = 'https://raw.githubusercontent.com/DenMartinCom/sajt-u-izradi/main';
const API = 'https://cmc-proxy.martin-denic.workers.dev';

const MARK_KEY_PREFIX = 'provera_mark_';
const RECENT_MS = 24 * 60 * 60 * 1000;

const state = {
  aktivniTab: 'cg',           // 'cg' | 'cs'
  mark: { cg: {}, cs: {} },
  obelezeni: { cg: new Set(), cs: new Set() },
  cmcIndex: {},
  cgIndex: {},
  csIndex: {},
  tokens: [],                 // [{simbol, cmc, cg, cs, grupa, cmc_podaci}]
  prikazani: [],
  strana: 0,
  sortiranje: 'nedavno',
  samo24h: false,
  kesPauza: '0'
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
// Prioritet grupa: 0 = novi_koini_upari, 1 = novi_koini, 2 = ostali
function grupaPrioritet(g) {
  if (g === 'upari') return 0;
  if (g === 'novi') return 1;
  return 2;
}

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
    l.sort((a, b) => {
      const pa = grupaPrioritet(a.grupa);
      const pb = grupaPrioritet(b.grupa);
      if (pa !== pb) return pa - pb;
      return String(a.simbol).localeCompare(String(b.simbol));
    });
  } else if (state.sortiranje === 'nedavno') {
    l.sort((a, b) => {
      const pa = grupaPrioritet(a.grupa);
      const pb = grupaPrioritet(b.grupa);
      if (pa !== pb) return pa - pb;
      const ma = mark[String(a.cmc)];
      const mb = mark[String(b.cmc)];
      const ta = (ma && ma.ts) ? ma.ts : 0;
      const tb = (mb && mb.ts) ? mb.ts : 0;
      return tb - ta;
    });
  } else {
    l.sort((a, b) => {
      const pa = grupaPrioritet(a.grupa);
      const pb = grupaPrioritet(b.grupa);
      return pa - pb;
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

    if (t.grupa === 'upari') red.classList.add('red-upari');
    else if (t.grupa === 'novi') red.classList.add('red-novi');

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
  const brojUpari = state.tokens.filter(x => x.grupa === 'upari').length;
  const brojNovi = state.tokens.filter(x => x.grupa === 'novi').length;
  const deo = (prik === sve) ? `${sve} tokena` : `${prik}/${sve} tokena`;
  const dodatak = (brojUpari || brojNovi) ? ` | čeka uparivanje: ${brojUpari}, za istoriju: ${brojNovi}` : '';
  document.getElementById('info').textContent = `${deo} | čekirano: ${ob}${dodatak}`;
}

// ===== PAUZA STATUS =====
async function osveziPauzaStatus() {
  try {
    const r = await fetch(`${API}/kes-pauza-status`, { cache: 'no-store' });
    const d = await r.json();
    if (d && d.ok) {
      state.kesPauza = d.kes_pauza;
      const badge = document.getElementById('pauza-badge');
      const btnK = document.getElementById('pusti-kes');
      if (badge) badge.classList.toggle('aktivna', d.kes_pauza === '1');
      if (btnK) btnK.classList.toggle('aktivna', d.kes_pauza === '1');
    }
  } catch (e) {}
}

// ===== PUSTI KES =====
async function pustiKes() {
  if (state.kesPauza !== '1') {
    alert('Keš već nije pauziran.');
    return;
  }
  if (!confirm('Pustiti keš? Upareni tokeni idu u novi_koini, neupareni se brišu iz meta.')) return;

  try {
    const r = await fetch(`${API}/pusti-kes`);
    const d = await r.json();
    if (d && d.ok) {
      let poruka = `Prebačeno u novi_koini: ${d.prebaceno_u_novi_koini}\n`;
      poruka += `Neupareno (ostaje za ručno): ${d.neupareno_ostaje}\n`;
      poruka += `Keš pauza: ${d.kes_pauza}`;
      alert(poruka);
      await osveziPauzaStatus();
      await pokreni();
    } else {
      alert('Greška: ' + (d && d.greska ? d.greska : 'nepoznato'));
    }
  } catch (e) {
    alert('Greška: ' + e.message);
  }
}

// ===== START =====
async function pokreni() {
  const info = document.getElementById('info');
  try {
    state.mark.cg = ucitajMark('cg');
    state.mark.cs = ucitajMark('cs');

    await osveziPauzaStatus();

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

    info.textContent = 'Upari status...';
    let noviKoiniSet = new Set();
    let upariSet = new Set();
    let upariLista = [];
    try {
      const us = await fetchJson(`${API}/upari-status`);
      if (us && us.ok) {
        if (Array.isArray(us.novi_koini_lista)) for (const id of us.novi_koini_lista) noviKoiniSet.add(String(id));
        if (Array.isArray(us.upari_lista)) {
          for (const n of us.upari_lista) {
            upariSet.add(String(n.cmc_id));
          }
          upariLista = us.upari_lista;
        }
      }
    } catch (e) {}

    state.tokens = [];

    // 1) novi_koini_upari (prioritet)
    for (const n of upariLista) {
      state.tokens.push({
        simbol: n.symbol || '',
        cmc: n.cmc_id,
        cg: null,
        cs: null,
        grupa: 'upari'
      });
    }

    // 2) meta (mapa po cmc_id)
    for (const [cmcId, i] of Object.entries(meta)) {
      if (i.cmc == null || !i.simbol) continue;
      const cmcStr = String(i.cmc);
      if (upariSet.has(cmcStr)) continue;   // već dodato gore
      const jeNovi = noviKoiniSet.has(cmcStr);
      state.tokens.push({
        simbol: i.simbol,
        cmc: i.cmc,
        cg: i.coingecko || null,
        cs: i.coinstats || null,
        grupa: jeNovi ? 'novi' : 'meta'
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

  // Prvo pauziraj keš
  try {
    await fetch(`${API}/kes-pauza?stanje=1`);
    await osveziPauzaStatus();
  } catch (e) {}

  try {
    const r = await fetch(`${API}/provera-sacuvaj?servis=${tab}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parovi })
    });
    const d = await r.json();
    if (d && d.ok) {
      alert(`Sačuvano ${d.broj} parova (${tab.toUpperCase()}). Keš je pauziran.`);
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
document.getElementById('pusti-kes').addEventListener('click', pustiKes);

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