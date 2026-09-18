// Padajući meni — deli ga sve stranice
(function () {
    const dropdownToggle = document.getElementById('dropdownToggle');
    const dropdownMenu = document.getElementById('dropdownMenu');

    if (!dropdownToggle || !dropdownMenu) return;

    dropdownToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdownMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => {
        dropdownMenu.classList.remove('open');
    });
})();
