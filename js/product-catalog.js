(() => {
  const list = document.querySelector('[data-product-list]');
  if (!list) return;
  const cards = [...list.querySelectorAll('[data-product]')];
  const radios = [...document.querySelectorAll('[data-category-input]')];
  const loadMore = document.querySelector('[data-load-more]');
  const empty = document.querySelector('[data-filter-empty]');
  const mobileWrap = document.querySelector('.filter_block-mobile');
  const mobileHeader = mobileWrap.querySelector('.filter_dd_label');
  const mobileList = mobileWrap.querySelector('.filter_list-2');
  mobileList.id = 'mobile-category-options';
  mobileHeader.setAttribute('role', 'button');
  mobileHeader.setAttribute('tabindex', '0');
  mobileHeader.setAttribute('aria-controls', mobileList.id);
  function toggleMobile(open) {
    mobileList.classList.toggle('is-collapsed', !open);
    mobileHeader.setAttribute('aria-expanded', String(open));
  }
  toggleMobile(false);
  mobileHeader.addEventListener('click', () => toggleMobile(mobileHeader.getAttribute('aria-expanded') !== 'true'));
  mobileHeader.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleMobile(mobileHeader.getAttribute('aria-expanded') !== 'true'); }
    if (event.key === 'Escape') toggleMobile(false);
  });
  document.addEventListener('click', event => { if (!mobileWrap.contains(event.target)) toggleMobile(false); });
  const categories = new Set(['All', ...cards.flatMap(card => JSON.parse(card.dataset.categories))]);
  const url = new URL(location.href);
  let category = [...categories].find(value => value.toLowerCase() === (url.searchParams.get('category') || 'All').toLowerCase()) || 'All';
  let order = 'default';
  let limit = 4;
  function render() {
    const matching = cards.filter(card => category === 'All' || JSON.parse(card.dataset.categories).includes(category));
    matching.sort((a, b) => {
      if (order.startsWith('name')) return a.dataset.name.localeCompare(b.dataset.name, 'en') * (order.endsWith('desc') ? -1 : 1);
      if (order.startsWith('price')) return (Number(a.dataset.price) - Number(b.dataset.price)) * (order.endsWith('desc') ? -1 : 1);
      return Number(a.dataset.order) - Number(b.dataset.order);
    });
    cards.forEach(card => { card.hidden = true; });
    matching.forEach((card, i) => { card.hidden = i >= limit; list.append(card); });
    const count = Math.min(matching.length, limit);
    loadMore.hidden = matching.length <= limit;
    empty.hidden = matching.length !== 0;
    for (const [selector, value] of [['[data-results-count]', matching.length], ['[data-visible-from]', count ? 1 : 0], ['[data-visible-to]', count], ['[data-items-count]', matching.length]]) document.querySelector(selector).textContent = value;
    radios.forEach(radio => {
      radio.checked = radio.value === category;
      radio.closest('.radio_field').classList.toggle('is-list-active', radio.checked);
    });
    document.querySelector('.filter_block-mobile .filter_dropdown_label').textContent = category === 'All' ? 'Filter' : category;
  }
  radios.forEach(radio => radio.addEventListener('change', () => {
    category = radio.value; limit = 4;
    const nextUrl = new URL(location.href);
    if (category === 'All') nextUrl.searchParams.delete('category');
    else nextUrl.searchParams.set('category', category);
    history.replaceState(null, '', nextUrl);
    render();
    toggleMobile(false);
  }));
  document.querySelectorAll('[data-sort]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault(); order = link.dataset.sort; limit = 4; render();
    const dropdown = link.closest('.w-dropdown');
    dropdown.querySelector('.filter_dropdown_label').textContent = link.textContent.trim();
    dropdown.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }));
  loadMore.addEventListener('click', () => { limit += 4; render(); });
  document.querySelector('[data-reset-filter]').addEventListener('click', event => {
    event.preventDefault(); category = 'All'; limit = 4;
    const nextUrl = new URL(location.href); nextUrl.searchParams.delete('category'); history.replaceState(null, '', nextUrl);
    render();
  });
  document.querySelectorAll('.filter_form').forEach(form => form.addEventListener('submit', event => event.preventDefault()));
  render();
})();
