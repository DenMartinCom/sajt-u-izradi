const LIMIT_TOKENA = 10;
const PER_PAGE = 40;
const RAW = 'https://raw.githubusercontent.com/DenMartinCom/sajt-u-izradi/main';
const API = 'https://cmc-proxy.martin-denic.workers.dev';

let cmcIndex = {};
let cgIndex = {};
let tokens = [];
let strana = 0;

async function fetchJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + url);
  return r.json();
}

function urlCmc(cmcId) {
  return `https://s2.coinmarketcap.com/static/img/coins/64x64/${cmcId}.png`;
}

function urlCg(zapis) {
  if (!zapis || !zapis.logo || typeof zapis.logo !== 'object') return null;
  if (zapis.logo.id == null || !zapis.logo.file) return null;
  return `https://assets.coingecko.com/coins/images/${zapis.logo.id}/large/${zapis.logo.file}`;
}

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
    ime.textContent = '—';
    simbol.textContent = '—';
  } else {
    ime.textContent = zapis.name || '—';
    simbol.textContent = zapis.symbol || '—';
    const url = tip === 'cmc' ? urlCmc(zapis.id) : urlCg(zapis);
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

function render() {
  const lista = document.getElementById('lista');
  lista.innerHTML = '';

  const start = strana * PER_PAGE;
  const end = Math.min(start + PER_PAGE, tokens.length);

  for (let i = start; i < end; i++) {
    const t = tokens[i];
    const red = document.createElement('div');
    red.className = 'red';

    const cmcZapis = t.cmc != null ? cmcIndex[String(t.cmc)] : null;
    const cgZapis = t.cg ? cgIndex[t.cg] : null;

    red.appendChild(napraviKarticu(cmcZapis, 'cmc'));
    red.appendChild(napraviKarticu(cgZapis, 'cg'));
    lista.appendChild(red);
  }

  const ukupnoStrana = Math.max(1, Math.ceil(tokens.length / PER_PAGE));
  document.getElementById('strana').textContent = `${strana + 1} / ${ukupnoStrana}`;
  document.getElementById('pre').disabled = strana === 0;
  document.getElementById('sle').disabled = strana >= ukupnoStrana - 1;
  document.getElementById('info').textContent = `${tokens.length} tokena`;
}

async function pokreni() {
  const info = document.getElementById('info');
  try {
    info.textContent = 'Meta...';
    const m = await fetchJson(`${API}/test?servis=meta`);
    const meta = m.meta || {};

    info.textContent = 'CMC mapa...';
    const cmcArr = await fetchJson(`${RAW}/0_Arhiva/d_coinmarketcap_map.json`);
    cmcIndex = {};
    if (Array.isArray(cmcArr)) for (const z of cmcArr) if (z.id != null) cmcIndex[String(z.id)] = z;

    info.textContent = 'CG mapa...';
    const cgArr = await fetchJson(`${RAW}/0_Arhiva/d_coingecko_map.json`);
    cgIndex = {};
    if (Array.isArray(cgArr)) for (const z of cgArr) if (z.id != null) cgIndex[String(z.id)] = z;

    tokens = [];
    for (const [simbol, i] of Object.entries(meta)) {
      tokens.push({
        simbol,
        cmc: i.cmc != null ? i.cmc : null,
        cg: i.coingecko || null
      });
      if (tokens.length >= LIMIT_TOKENA) break;
    }

    strana = 0;
    render();
  } catch (e) {
    info.textContent = 'Greška: ' + e.message;
    console.error(e);
  }
}

document.getElementById('pre').addEventListener('click', () => {
  if (strana > 0) { strana--; render(); }
});
document.getElementById('sle').addEventListener('click', () => {
  const ukupno = Math.ceil(tokens.length / PER_PAGE);
  if (strana < ukupno - 1) { strana++; render(); }
});
document.getElementById('reload').addEventListener('click', pokreni);

pokreni();