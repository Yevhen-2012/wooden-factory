(() => {
  const links = [...document.querySelectorAll('.cms-gallery-open')];
  const dialog = document.querySelector('.lb');
  if (!links.length || !dialog) return;
  const image = dialog.querySelector('.lb__img');
  const closeButton = dialog.querySelector('.lb__close');
  const previousButton = dialog.querySelector('.lb__prev');
  const nextButton = dialog.querySelector('.lb__next');
  const counter = dialog.querySelector('.lb__counter');
  const controls = [closeButton, previousButton, nextButton];
  let index = 0;
  let opener;
  let startX;
  function show(nextIndex) {
    index = (nextIndex + links.length) % links.length;
    image.src = links[index].href;
    image.alt = links[index].querySelector('img').alt;
    counter.textContent = `${index + 1} / ${links.length}`;
  }
  function close() {
    dialog.classList.remove('is-open');
    dialog.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('lb-lock');
    document.body.classList.remove('lb-lock');
    opener?.focus({ preventScroll: true });
  }
  links.forEach((link, i) => link.addEventListener('click', event => {
    event.preventDefault();
    opener = link;
    show(i);
    dialog.classList.add('is-open');
    dialog.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('lb-lock');
    document.body.classList.add('lb-lock');
    closeButton.focus();
  }));
  closeButton.addEventListener('click', close);
  dialog.querySelector('.lb__backdrop').addEventListener('click', close);
  previousButton.addEventListener('click', () => show(index - 1));
  nextButton.addEventListener('click', () => show(index + 1));
  document.addEventListener('keydown', event => {
    if (!dialog.classList.contains('is-open')) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); show(index + 1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); show(index - 1); }
    if (event.key === 'Tab') {
      const current = controls.indexOf(document.activeElement);
      event.preventDefault();
      controls[(current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
    }
  });
  dialog.addEventListener('touchstart', event => { startX = event.touches[0].clientX; }, { passive: true });
  dialog.addEventListener('touchend', event => {
    if (startX === undefined) return;
    const delta = event.changedTouches[0].clientX - startX;
    startX = undefined;
    if (Math.abs(delta) > 40) show(index + (delta < 0 ? 1 : -1));
  }, { passive: true });
})();
