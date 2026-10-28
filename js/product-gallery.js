(() => {
  const main = document.querySelector('.product-main-img');
  const zoom = document.querySelector('[data-product-zoom]');
  const buttons = [...document.querySelectorAll('.product-photo-button')];
  if (!main || !buttons.length) return;
  buttons.forEach(button => button.addEventListener('click', () => {
    main.src = button.dataset.image;
    main.alt = button.querySelector('img').alt;
    zoom.href = button.dataset.image;
    buttons.forEach(item => {
      const active = item === button;
      item.setAttribute('aria-pressed', String(active));
      item.querySelector('img').classList.toggle('is-active-thumb', active);
    });
  }));
})();
