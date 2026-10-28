import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readCsv, writeCsv, escapeHtml as esc } from './lib/csv.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv[2]) throw new Error('Usage: node scripts/import-products.mjs path/to/products.csv');
const { headers, records } = readCsv(await fs.readFile(path.resolve(process.argv[2]), 'utf8'), [
  'Product ID', 'Variant ID', 'Product Handle', 'Product Name', 'Product Description',
  'Product Categories', 'Main Variant Image', 'More Variant Images', 'Variant Price', 'Published On'
]);
const rows = records.filter(row => row['Published On'].trim());
const categoryMap = JSON.parse(await fs.readFile(path.join(root, 'data/product-categories.json'), 'utf8'));
const assets = new Map();
const handles = new Set();
function asset(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.prod.website-files.com') throw new Error(`Unexpected image host: ${url}`);
  const name = decodeURIComponent(parsed.pathname.split('/').pop()).replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!/\.(webp|jpe?g|png|avif)$/i.test(name)) throw new Error(`Unexpected image type: ${url}`);
  const target = `images/products/${name}`;
  for (const [existing, file] of assets) if (file === target && existing !== url) throw new Error(`Image name collision: ${target}`);
  assets.set(url, target);
  return target;
}
function euroPrice(value) {
  const match = value.trim().match(/^€\s*(\d+(?:,\d{3})*)(?:\.(\d{2}))?$/);
  if (!match) throw new Error(`Unsupported price: ${value}`);
  const cents = Number(match[1].replaceAll(',', '')) * 100 + Number(match[2] || 0);
  if (!Number.isSafeInteger(cents)) throw new Error(`Invalid price: ${value}`);
  return { cents, currency: 'EUR', display: `€${(cents / 100).toFixed(2)}` };
}
const products = rows.map(row => {
  const slug = row['Product Handle'];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || handles.has(slug)) throw new Error(`Invalid handle or multiple variants requiring a mapping: ${slug}`);
  handles.add(slug);
  if (!row['Product Name'].trim()) throw new Error(`Missing product name: ${slug}`);
  const categories = row['Product Categories'].trim()
    ? row['Product Categories'].split(';').map(value => value.trim()).filter(Boolean)
    : categoryMap[slug]?.categories || [];
  const imageUrls = [...new Set([row['Main Variant Image'], ...row['More Variant Images'].split(';').map(value => value.trim())].filter(Boolean))];
  return {
    id: row['Product ID'], variantId: row['Variant ID'], slug, name: row['Product Name'].trim(),
    description: row['Product Description'], type: row['Product Type'], categories,
    categorySource: row['Product Categories'].trim() ? 'CSV' : categoryMap[slug]?.source || null,
    price: euroPrice(row['Variant Price']),
    compareAtPrice: row['Variant Compare-at Price'] ? euroPrice(row['Variant Compare-at Price']) : null,
    sku: row['Variant Sku'], inventory: row['Variant Inventory'] || null,
    requiresShipping: row['Requires Shipping'] === 'true',
    dimensions: Object.fromEntries(['Weight', 'Width', 'Height', 'Length'].map(key => [key.toLowerCase(), row[`Variant ${key}`] || null])),
    options: [1, 2, 3].filter(i => row[`Option${i} Name`]).map(i => ({ name: row[`Option${i} Name`], value: row[`Option${i} Value`] })),
    cover: asset(row['Main Variant Image']), images: imageUrls.map(asset),
    source: { cover: row['Main Variant Image'], images: imageUrls, publishedOn: row['Published On'] }
  };
});
if (!products.length) throw new Error('No published products in CSV');

await fs.mkdir(path.join(root, 'images/products'), { recursive: true });
const exec = promisify(execFile);
function validImage(bytes) {
  return bytes.length > 100 && (bytes.subarray(0, 2).toString('hex') === 'ffd8'
    || bytes.subarray(8, 12).toString() === 'WEBP' || bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    || bytes.subarray(4, 12).toString().startsWith('ftypavif'));
}
const queue = [...assets.entries()];
let downloaded = 0;
await Promise.all(Array.from({ length: Math.min(5, queue.length) }, async () => {
  while (queue.length) {
    const [url, relative] = queue.shift();
    const target = path.join(root, relative);
    try { if (validImage(await fs.readFile(target))) continue; } catch {}
    let bytes;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`Image download HTTP ${response.status}: ${url}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      // Windows trusts some local CA chains that are absent from Node's bundled store.
      // Use the system HTTPS client with certificate verification still enabled.
      if (process.platform !== 'win32' || !['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.cause?.code)) throw error;
      const temporary = target + '.part';
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Invoke-WebRequest -UseBasicParsing -Uri $env:WOODEN_CMS_ASSET_URL -OutFile $env:WOODEN_CMS_ASSET_FILE"], {
        env: { ...process.env, WOODEN_CMS_ASSET_URL: url, WOODEN_CMS_ASSET_FILE: temporary }, timeout: 60000
      });
      bytes = await fs.readFile(temporary);
      await fs.unlink(temporary);
    }
    if (!validImage(bytes)) throw new Error(`Invalid image bytes: ${url}`);
    await fs.writeFile(target, bytes); downloaded++;
  }
}));

let catalog = await fs.readFile(path.join(root, 'templates/product-categories.html'), 'utf8');
const cards = products.map((product, i) => `                      <div role="listitem" class="cms_list-item w-dyn-item" data-product data-name="${esc(product.name)}" data-price="${product.price.cents}" data-categories="${esc(JSON.stringify(product.categories))}" data-order="${i}">
                        <a href="product/${product.slug}/" class="collection_link card w-inline-block">
                          <img loading="${i < 4 ? 'eager' : 'lazy'}" src="${product.cover}" alt="${esc(product.name)}" class="collection-img margin-xs">
                          <h2 class="h-catalog">${esc(product.name)}</h2>
                          <div class="collecyion-text-wraper"><span class="text">${product.price.display}</span>${product.compareAtPrice ? `<del class="text">${product.compareAtPrice.display}</del>` : ''}</div>
                        </a>
                      </div>`).join('\n');
const listPattern = /<div class="cms_list-wrapper w-dyn-list">[\s\S]*?(?=\n                  <div fs-list-element="empty")/;
if (!listPattern.test(catalog)) throw new Error('Cannot find catalog list in template');
catalog = catalog.replace(listPattern, `<div class="cms_list-wrapper w-dyn-list">\n                    <div role="list" class="cms_list helper w-dyn-items" data-product-list>\n${cards}\n                    </div>\n                    <div class="w-pagination-wrapper pagination"><button type="button" class="w-pagination-next button_more" data-load-more hidden>Load more</button></div>\n                  </div>`);
let radioNumber = 0;
let filterFormNumber = 0;
catalog = catalog.replace(/id="wf-form-filter"/g, () => `id="filter-form-${filterFormNumber++ === 0 ? 'desktop' : 'mobile'}"`);
catalog = catalog.replace(/<label\b[\s\S]*?<\/label>/g, label => {
  if (!label.includes('radio_field')) return label;
  const category = label.match(/>(All|Bedroom|Kitchen|Livingroom)<\/span>/)?.[1];
  if (!category) throw new Error('Unexpected catalog category control');
  const group = radioNumber < 4 ? 'desktop' : 'mobile';
  const id = `category-${group}-${category.toLowerCase()}`;
  radioNumber++;
  return `<label data-category="${category}" class="radio_field helper w-radio" for="${id}"><div class="w-form-formradioinput w-form-formradioinput--inputType-custom radio_button helper w-radio-input"></div><input type="radio" id="${id}" name="category-${group}" value="${category}" data-category-input style="opacity:0;position:absolute;z-index:-1"${category === 'All' ? ' checked' : ''}><span class="radio_label w-form-label">${category}</span></label>`;
});
catalog = catalog.replace(/fs-list-field="(name-asc|name-desc|price-asc|price-desc)"/g, 'data-sort="$1"');
catalog = catalog.replace('class="filter_block-mobile"', 'class="filter_block-mobile" data-filter-init="true"');
catalog = catalog.replaceAll('class="filter_dropdown_link helper w-inline-block"', 'class="filter_dropdown_link helper w-inline-block w-dropdown-link"');
catalog = catalog.replace(/<div class="filter_tags">[\s\S]*?(?=\n                  <div class="cms_list-wrapper)/, '');
catalog = catalog.replace('class="filter_empty helper"', 'class="filter_empty helper" data-filter-empty hidden')
  .replace('There are no available cars matching the current filters.', 'No products match this category.')
  .replace('fs-list-element="clear" href="#" class="filter_clear-all', 'data-reset-filter href="#" class="filter_clear-all')
  .replace('class="filter_results_wrapper"', 'class="filter_results_wrapper" role="status" aria-live="polite"')
  .replace('fs-list-element="results-count"', 'data-results-count')
  .replace('fs-list-element="visible-count-from"', 'data-visible-from')
  .replace('fs-list-element="visible-count-to"', 'data-visible-to')
  .replace('fs-list-element="items-count"', 'data-items-count');
catalog = catalog.replace(/\sfs-[\w-]+="[^"]*"/g, '');
const oldScriptsStart = catalog.indexOf('  <!--  Finsweet Attributes');
if (oldScriptsStart === -1) throw new Error('Cannot find old filter scripts');
catalog = catalog.slice(0, oldScriptsStart) + '  <script src="js/product-catalog.js" defer></script>\n</body>\n</html>\n';
catalog = catalog.replace('</head>', '  <link href="css/products.css" rel="stylesheet">\n</head>')
  .replace('<title>categories</title>', '<title>Furniture Collection | Wooden Factory</title>')
  .replace('href="#" class="footer-link">Latest Projects', 'href="index.html#latest-projects" class="footer-link">Latest Projects');
catalog = catalog.replace(/^[ \t]+$/gm, '');

const template = await fs.readFile(path.join(root, 'detail_product.html'), 'utf8');
let previous = [];
try { previous = JSON.parse(await fs.readFile(path.join(root, 'data/products.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const product of products) {
  const section = `<section class="section_hero-product">
      <div class="padding-global"><div class="w-layout-blockcontainer container-narrow w-container">
        <div class="breadcrumbs-wraper margin-s"><a href="index.html" class="breadcrumbs-link">Home</a><span class="text" aria-hidden="true">/</span><a href="product-categories.html" class="breadcrumbs-link">Catalog</a><span class="text" aria-hidden="true">/</span><span class="breadcrumbs-link" aria-current="page">${esc(product.name)}</span></div>
        <div class="product-content-wraper margin-m">
          <div class="product-content-img">
            <a href="${product.cover}" data-product-zoom><img src="${product.cover}" alt="${esc(product.name)}" class="product-main-img margin-xs" loading="eager"></a>
            <div class="product-thumbs"><div class="cms-list" role="group" aria-label="${esc(product.name)} photos">
${product.images.map((image, i) => `              <button type="button" class="cms-product-item product-photo-button" data-image="${image}" aria-label="View ${esc(product.name)} photo ${i + 1}" aria-pressed="${i === 0}"><img src="${image}" alt="${esc(product.name)} — photo ${i + 1}" class="product-thumb${i === 0 ? ' is-active-thumb' : ''}" loading="lazy"></button>`).join('\n')}
            </div></div>
          </div>
          <div class="product-content-text">
            <h1 class="h-3 margin-s">${esc(product.name)}</h1>
            <div class="product-price-wraper margin-s text-mdl"><span class="text">${product.price.display}</span>${product.compareAtPrice ? `<del class="text">${product.compareAtPrice.display}</del>` : ''}</div>
            <h2 class="h-6 margin-xs underline">Quick Overview</h2>
            <p class="text">${esc(product.description).replaceAll('\n', '<br>')}</p>
            ${product.categories.length ? `<p class="text"><strong>Category:</strong> ${esc(product.categories.join(', '))}</p>` : ''}
            ${product.sku ? `<p class="text"><strong>SKU:</strong> ${esc(product.sku)}</p>` : ''}
            <div class="add_to-cart"><a href="contacts.html?product=${product.slug}" class="button_add-to-cart">Contact us to order</a></div>
          </div>
        </div>
        <div class="product-secondery-content"><div class="margin-xs"><h2 class="h-5 underline">Delivery &amp; Installation</h2></div><div class="text">Each piece is delivered with the utmost care, reflecting our commitment to exceptional craftsmanship. Your order is expertly packaged and entrusted to our premium logistics partners to ensure a seamless journey to your home. Delivery times may vary by region, and every item can be inspected upon arrival. White-glove options, including in-home placement and assembly, are available to elevate your experience even further.</div></div>
      </div></div>
    </section>`;
  let page = template.replace(/<section class="section_hero-product">[\s\S]*?<\/section>/, section)
    .replace(/<section class="section_recomended">[\s\S]*?<\/section>/, '')
    .replace('<!DOCTYPE html>', '<!DOCTYPE html>\n<!-- Generated by scripts/import-products.mjs -->')
    .replace(/<title>.*?<\/title>/, `<title>${esc(product.name)} | Wooden Factory</title>`)
    .replace('</head>', `  <meta name="description" content="${esc(product.description)}">\n  <link href="css/products.css" rel="stylesheet">\n</head>`)
    .replace('href="#" class="footer-link">Latest Projects', 'href="index.html#latest-projects" class="footer-link">Latest Projects');
  const oldScript = page.indexOf('  <style>\n .cart-quantity');
  if (oldScript === -1) throw new Error('Cannot find product gallery script');
  page = page.slice(0, oldScript) + '  <script src="js/product-gallery.js" defer></script>\n</body>\n</html>\n';
  page = page.replace(/\b(href|src|srcset|data-image)="([^"]*)"/g, (match, attribute, value) => {
    if (!value || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(value)) return match;
    return `${attribute}="${attribute === 'srcset' ? value.split(',').map(item => '../../' + item.trim()).join(', ') : '../../' + value}"`;
  });
  const directory = path.join(root, 'product', product.slug);
  await fs.mkdir(directory, { recursive: true });
  page = page.replace(/^[ \t]+/gm, whitespace => whitespace.replaceAll('\t', '  ')).replace(/[ \t]+$/gm, '');
  await fs.writeFile(path.join(directory, 'index.html'), page);
}
for (const old of previous) {
  if (handles.has(old.slug)) continue;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(old.slug)) throw new Error('Invalid old product handle');
  const file = path.join(root, 'product', old.slug, 'index.html');
  try {
    if (!(await fs.readFile(file, 'utf8')).includes('<!-- Generated by scripts/import-products.mjs -->')) throw new Error(`Unmanaged page: ${file}`);
    await fs.unlink(file); await fs.rmdir(path.dirname(file));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await fs.writeFile(path.join(root, 'product-categories.html'), catalog);
await fs.writeFile(path.join(root, 'data/products.json'), JSON.stringify(products, null, 2) + '\n');
await fs.writeFile(path.join(root, 'data/products.csv'), writeCsv(headers, rows));
console.log(JSON.stringify({ records: records.length, publishedProducts: products.length, uniqueImages: assets.size, downloaded, categories: [...new Set(products.flatMap(product => product.categories))] }, null, 2));
