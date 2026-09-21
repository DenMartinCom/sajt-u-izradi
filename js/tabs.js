// ===== TABOVI =====
(function () {
  const tabs = document.querySelectorAll('.tab');
  const contents = document.querySelectorAll('.tab-content');
  if (!tabs.length || !contents.length) return;

  function aktiviraj(tabId) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
    contents.forEach(c => c.classList.toggle('active', c.id === tabId));
    try { localStorage.setItem('kripto_tab', tabId); } catch (e) {}
  }

  tabs.forEach(t => {
    t.addEventListener('click', () => aktiviraj(t.dataset.tab));
  });

  // Zapamti zadnji tab
  try {
    const zadnji = localStorage.getItem('kripto_tab');
    if (zadnji && document.getElementById(zadnji)) aktiviraj(zadnji);
  } catch (e) {}
})();
