const PER_PAGE = 40;
const RAW = 'https://raw.githubusercontent.com/DenMartinCom/sajt-u-izradi/main';
const API = 'https://cmc-proxy.martin-denic.workers.dev';

let cmcIndex = {};
let cgIndex = {};
let tokens = [];
let strana = 0;
let obelezeni = new Set();   // cmc_id (string) — sve što je čekirano

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
    ime.textContent = '/';
    simbol.textContent = '/';
  } else {
    ime.textContent = zapis.name || '/';
    simbol.textContent = zapis.symbol || '/';
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

    // checkbox
    const cek = document.createElement('div');
    cek.className = 'cek';
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = obelezeni.has(String(t.cmc));
    inp.dataset.cmc = String(t.cmc);
    inp.addEventListener('change', () => {
      if (inp.checked) obelezeni.add(String(t.cmc));
      else obelezeni.delete(String(t.cmc));
      azurirajInfo();
    });
    cek.appendChild(inp);

    const cmcZapis = t.cmc != null ? cmcIndex[String(t.cmc)] : null;
    const cgZapis = t.cg ? cgIndex[t.cg] : null;

    red.appendChild(cek);
    red.appendChild(napraviKarticu(cmcZapis, 'cmc'));
    red.appendChild(napraviKarticu(cgZapis, 'cg'));
    lista.appendChild(red);
  }

  const ukupnoStrana = Math.max(1, Math.ceil(tokens.length / PER_PAGE));
  document.getElementById('strana').textContent = `${strana + 1} / ${ukupnoStrana}`;
  document.getElementById('pre').disabled = strana === 0;
  document.getElementById('sle').disabled = strana >= ukupnoStrana - 1;
  azurirajInfo();
}

function azurirajInfo() {
  document.getElementById('info').textContent = `${tokens.length} tokena | čekirano: ${obelezeni.size}`;
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
      if (i.cmc == null) continue;   // samo tokeni sa cmc_id
      tokens.push({
        simbol,
        cmc: i.cmc,
        cg: i.coingecko || null
      });
    }

    // auto-čekiraj one kojima fali cg
    obelezeni = new Set();
    for (const t of tokens) {
      if (t.cg == null) obelezeni.add(String(t.cmc));
    }

    strana = 0;
    render();
  } catch (e) {
    info.textContent = 'Greška: ' + e.message;
    console.error(e);
  }
}

async function generisi() {
  if (!obelezeni.size) {
    alert('Nema obeleženih.');
    return;
  }
  const parovi = [];
  for (const t of tokens) {
    if (!obelezeni.has(String(t.cmc))) continue;
    parovi.push({ cmc: t.cmc, cg: t.cg != null ? t.cg : null });
  }
  try {
    const r = await fetch(`${API}/provera-sacuvaj`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parovi })
    });
    const d = await r.json();
    if (d && d.ok) {
      alert(`Sačuvano ${d.broj} parova u 0_Arhiva/provera_cmc-cg.csv`);
      obelezeni = new Set();
      render();
    } else {
      alert('Greška: ' + (d && d.greska ? d.greska : 'nepoznato'));
    }
  } catch (e) {
    alert('Greška: ' + e.message);
  }
}

document.getElementById('pre').addEventListener('click', () => {
  if (strana > 0) { strana--; render(); }
});
document.getElementById('sle').addEventListener('click', () => {
  const ukupno = Math.ceil(tokens.length / PER_PAGE);
  if (strana < ukupno - 1) { strana++; render(); }
});
document.getElementById('reset').addEventListener('click', () => {
  obelezeni = new Set();
  render();
});
document.getElementById('gen').addEventListener('click', generisi);
document.getElementById('reload').addEventListener('click', pokreni);

pokreni();