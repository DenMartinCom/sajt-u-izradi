(function () {
  const WORKER_URL = 'https://cmc-proxy.martin-denic.workers.dev';
  const KES_KEY = 'kes_meta_v1';
  const KES_MS = 60 * 1000;

  // Sve kolone iz kripto_kes (34) — za filter "bez svih"
  const KES_KOLONE = [
    'cmc_id', 'simbol', 'cena', 'vreme', 'izvor', 'rank',
    'volumen_24h', 'market_cap',
    'pr_cena_15m', 'pr_cena_30m', 'pr_cena_1h', 'pr_cena_6h', 'pr_cena_12h', 'pr_cena_24h',
    'pr_cena_7d', 'pr_cena_14d', 'pr_cena_30d', 'pr_cena_60d', 'pr_cena_90d', 'pr_cena_200d', 'pr_cena_1y',
    'pr_vol_15m', 'pr_vol_30m', 'pr_vol_1h', 'pr_vol_6h', 'pr_vol_12h', 'pr_vol_24h',
    'pr_vol_7d', 'pr_vol_14d', 'pr_vol_30d', 'pr_vol_60d', 'pr_vol_90d', 'pr_vol_200d', 'pr_vol_1y'
  ];

  let podaci = [];

  const $ = id => document.getElementById(id);
  const listaEl = $('lista');
  const infoEl = $('info');

  const fCena = (v) => {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    let dec;
    if (a >= 1000) dec = 2;
    else if (a >= 1) dec = 4;
    else if (a >= 0.01) dec = 6;
    else dec = 8;
    return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dec });
  };

  const fProc = (v) => {
    if (v == null || !isFinite(v)) return '—';
    const s = v > 0 ? '+' : '';
    return s + v.toFixed(2) + '%';
  };

  const klasaProc = (v) => {
    if (v == null || !isFinite(v)) return 'zero';
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return 'zero';
  };

  const fVreme = (ms) => {
    if (!ms) return '—';
    const d = new Date(ms);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}.${mm}. ${hh}:${mi}`;
  };

  const esc = (s) => {
    if (s == null) return '';
    let str;
    if (typeof s === 'object') {
      try { str = JSON.stringify(s); } catch (e) { str = String(s); }
    } else {
      str = String(s);
    }
    return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };

  async function ucitaj() {
    try {
      const r = sessionStorage.getItem(KES_KEY);
      if (r) {
        const k = JSON.parse(r);
        if (Date.now() - k.vreme < KES_MS) {
          podaci = k.podaci || [];
          return;
        }
      }
    } catch (e) {}

    infoEl.textContent = 'Učitavanje...';
    try {
      const resp = await fetch(`${WORKER_URL}/kes-meta`);
      const d = await resp.json();
      if (!d.ok) throw new Error(d.greska || 'greška');
      podaci = d.redovi || [];
      try {
        sessionStorage.setItem(KES_KEY, JSON.stringify({ vreme: Date.now(), podaci }));
      } catch (e) {}
    } catch (e) {
      infoEl.textContent = 'Greška: ' + e.message;
      podaci = [];
    }
  }

  function napuniIzvorFilter() {
    const izvori = new Set();
    for (const r of podaci) if (r.izvor) izvori.add(r.izvor);
    const sel = $('izvor-filter');
    const trenutni = sel.value;
    sel.innerHTML = '<option value="">svi izvori</option>' +
      Array.from(izvori).sort().map(i => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
    if (trenutni) sel.value = trenutni;
  }

  function imaPraznoPolje(r) {
    for (const k of KES_KOLONE) {
      if (r[k] == null) return true;
    }
    return false;
  }

  function filtriraj() {
    const pretraga = $('pretraga').value.trim().toLowerCase();
    const izvor = $('izvor-filter').value;
    const bezCene = $('f-bez-cene').checked;
    const bezSvih = $('f-bez-svih').checked;
    const bezLogo = $('f-bez-logo').checked;

    return podaci.filter(r => {
      if (izvor && r.izvor !== izvor) return false;
      if (bezCene && r.cena != null) return false;
      if (bezLogo && r.logo_lokalno && r.logo_lokalno !== 'Slike/Coins/_default.png') return false;
      if (bezSvih && !imaPraznoPolje(r)) return false;
      if (pretraga) {
        const s = (String(r.simbol || '') + ' ' + String(r.naziv || '') + ' ' + String(r.cmc_id || '')).toLowerCase();
        if (!s.includes(pretraga)) return false;
      }
      return true;
    });
  }

  const POLJA_CENA = [
    ['pr_cena_15m', '15m'], ['pr_cena_30m', '30m'], ['pr_cena_1h', '1h'], ['pr_cena_6h', '6h'],
    ['pr_cena_12h', '12h'], ['pr_cena_24h', '24h'], ['pr_cena_7d', '7d'], ['pr_cena_14d', '14d'],
    ['pr_cena_30d', '30d'], ['pr_cena_60d', '60d'], ['pr_cena_90d', '90d'], ['pr_cena_200d', '200d'], ['pr_cena_1y', '1y']
  ];

  const POLJA_VOL = [
    ['pr_vol_15m', '15m'], ['pr_vol_30m', '30m'], ['pr_vol_1h', '1h'], ['pr_vol_6h', '6h'],
    ['pr_vol_12h', '12h'], ['pr_vol_24h', '24h'], ['pr_vol_7d', '7d'], ['pr_vol_14d', '14d'],
    ['pr_vol_30d', '30d'], ['pr_vol_60d', '60d'], ['pr_vol_90d', '90d'], ['pr_vol_200d', '200d'], ['pr_vol_1y', '1y']
  ];

  function polje(k, v, jeProc) {
    const prazno = (v == null || v === '');
    let tekst;
    if (prazno) tekst = '—';
    else if (jeProc) tekst = fProc(parseFloat(v));
    else tekst = esc(v);
    const duga = (!jeProc && typeof v === 'string' && v.length > 40) ? ' dugacko' : '';
    return `<div class="det-polje${duga}"><span class="k">${esc(k)}</span><span class="v${prazno ? ' null' : ''}">${tekst}</span></div>`;
  }

  function detSekcija(naslov, polja) {
    return `<div class="det-sekcija"><div class="det-naslov">${esc(naslov)}</div><div class="det-grid">${polja.join('')}</div></div>`;
  }

  function renderRed(r) {
    const logo = r.logo_lokalno || 'Slike/Coins/_default.png';
    const cenaT = r.cena != null ? '$' + fCena(r.cena) : '—';
    const p1 = r.pr_cena_1h;
    const p24 = r.pr_cena_24h;
    const p7 = r.pr_cena_7d;

    const cenePolja = POLJA_CENA.map(([k, l]) => polje(l, r[k], true));
    const volPolja = POLJA_VOL.map(([k, l]) => polje(l, r[k], true));

    const metaIdPolja = [
      polje('cmc_id', r.cmc_id),
      polje('coingecko_id', r.coingecko_id),
      polje('coinstats_id', r.coinstats_id),
      polje('coinpaprika_id', r.coinpaprika_id),
      polje('cryptorank_id', r.cryptorank_id),
      polje('cmc_slug', r.cmc_slug)
    ];

    const metaOsnPolja = [
      polje('naziv', r.naziv),
      polje('rank', r.rank),
      polje('volumen_24h', r.volumen_24h),
      polje('market_cap', r.market_cap),
      polje('decimals', r.decimals),
      polje('stablecoin', r.je_stablecoin ? 'da' : 'ne'),
      polje('izvor', r.izvor),
      polje('vreme', fVreme(r.vreme))
    ];

    const metaOstPolja = [
      polje('logo_lokalno', r.logo_lokalno),
      polje('website', r.website),
      polje('explorer', r.explorer),
      polje('contract', r.contract),
      polje('description', r.description)
    ];

    return `
      <div class="red">
        <div class="red-glava">
          <img class="logo" src="${esc(logo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
          <span class="simbol">${esc(r.simbol)}</span>
          <span class="naziv">${esc(r.naziv || '')}</span>
          <span class="cena">${cenaT}</span>
          <span class="proc ${klasaProc(p1)}">${fProc(p1)}</span>
          <span class="proc ${klasaProc(p24)}">${fProc(p24)}</span>
          <span class="proc ${klasaProc(p7)}">${fProc(p7)}</span>
          <span class="izvor">${esc(r.izvor || '')}</span>
        </div>
        <div class="red-det">
          ${detSekcija('Promene cene', cenePolja)}
          ${detSekcija('Promene volumena', volPolja)}
          ${detSekcija('Meta ID-jevi', metaIdPolja)}
          ${detSekcija('Osnovno', metaOsnPolja)}
          ${detSekcija('Ostalo', metaOstPolja)}
        </div>
      </div>
    `;
  }

  function render() {
    const filtrirano = filtriraj();
    infoEl.textContent = `Ukupno: ${podaci.length} | Prikazano: ${filtrirano.length}`;

    if (!filtrirano.length) {
      listaEl.innerHTML = '<div style="padding:20px;text-align:center;color:#8892a6;">Nema podataka za prikaz</div>';
      return;
    }

    listaEl.innerHTML = filtrirano.map(renderRed).join('');

    listaEl.querySelectorAll('.red-glava').forEach(el => {
      el.addEventListener('click', () => {
        el.parentElement.classList.toggle('detaljno');
      });
    });
  }

  (async () => {
    await ucitaj();
    napuniIzvorFilter();
    render();
  })();

  let timer;
  const onFilter = () => {
    clearTimeout(timer);
    timer = setTimeout(render, 200);
  };

  $('pretraga').addEventListener('input', onFilter);
  $('izvor-filter').addEventListener('change', render);
  $('f-bez-cene').addEventListener('change', render);
  $('f-bez-svih').addEventListener('change', render);
  $('f-bez-logo').addEventListener('change', render);

  $('osvezi').addEventListener('click', async () => {
    try { sessionStorage.removeItem(KES_KEY); } catch (e) {}
    await ucitaj();
    napuniIzvorFilter();
    render();
  });
})();