import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/import-projects.mjs path/to/projects.csv');

// RFC 4180 quoted fields, including embedded commas, quotes and line breaks.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\r' || c === '\n')) {
      row.push(field); field = '';
      if (c !== ',') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
    } else field += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift();
  const required = ['Name', 'Slug', 'Item ID', 'Archived', 'Draft', 'cover image', 'short description', 'full description', 'Gallery Images', 'location', 'Completion Date'];
  for (const name of required) if (!headers?.includes(name)) throw new Error(`Missing CSV column: ${name}`);
  return rows.map((values, i) => {
    if (values.length !== headers.length) throw new Error(`Invalid field count on CSV record ${i + 2}`);
    return Object.fromEntries(headers.map((key, j) => [key, values[j]]));
  });
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function richText(html) {
  // Only retain the content tags used by this export; never import scripts or attributes.
  const allowed = new Set(['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'blockquote']);
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, tag => {
    const match = tag.match(/^<(\/?)\s*([a-z0-9]+)/i);
    if (!match || !allowed.has(match[2].toLowerCase())) throw new Error(`Unsupported rich-text tag: ${tag}`);
    return `<${match[1]}${match[2].toLowerCase()}>`;
  });
}
const inputRows = parseCsv(await fs.readFile(path.resolve(source), 'utf8'));
const published = inputRows.filter(row => row.Archived.toLowerCase() === 'false' && row.Draft.toLowerCase() === 'false');
let previousProjects = [];
try { previousProjects = JSON.parse(await fs.readFile(path.join(root, 'data/projects.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const slugs = new Set();
const assets = new Map();
await fs.mkdir(path.join(root, 'images/projects'), { recursive: true });
function assetPath(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.prod.website-files.com') throw new Error(`Unexpected asset host: ${url}`);
  const name = decodeURIComponent(parsed.pathname.split('/').pop()).replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!/\.(webp|png|jpe?g|avif)$/i.test(name)) throw new Error(`Unexpected image format: ${url}`);
  const local = `images/projects/${name}`;
  const collision = Array.from(assets.entries()).find(([other, target]) => target === local && other !== url);
  if (collision) throw new Error(`Image filename collision: ${name}`);
  assets.set(url, local);
  return local;
}

const projects = published.map(row => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.Slug) || slugs.has(row.Slug)) throw new Error(`Invalid or duplicate slug: ${row.Slug}`);
  slugs.add(row.Slug);
  const date = new Date(row['Completion Date']);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid completion date: ${row.Slug}`);
  const gallerySources = [...new Set(row['Gallery Images'].split(';').map(url => url.trim()).filter(Boolean))];
  return {
    id: row['Item ID'], slug: row.Slug, name: row.Name,
    shortDescription: row['short description'], fullDescription: richText(row['full description']),
    location: row.location, completionDate: date.toISOString().slice(0, 10),
    cover: assetPath(row['cover image']), gallery: gallerySources.map(assetPath),
    source: { cover: row['cover image'], gallery: gallerySources }
  };
}).sort((a, b) => b.completionDate.localeCompare(a.completionDate) || a.slug.localeCompare(b.slug));
if (!projects.length) throw new Error('No published CMS projects found');

// Download assets before generating pages. A failed download must not produce a partial site.
const queue = [...assets.entries()];
let downloaded = 0;
await Promise.all(Array.from({ length: Math.min(5, queue.length) }, async () => {
  while (queue.length) {
    const [url, relative] = queue.shift();
    const target = path.join(root, relative);
    try { if ((await fs.stat(target)).size > 0) continue; } catch {}
    let error;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error(`Image response ${response.status}: ${url}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length) throw new Error(`Empty image: ${url}`);
        await fs.writeFile(target, bytes); downloaded++; error = undefined; break;
      } catch (cause) { error = cause; }
    }
    if (error) throw error;
  }
}));

const formatDate = date => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(date));
const cards = projects.map(project => `                <div role="listitem" class="w-dyn-item">
                  <a href="latest-project/${project.slug}/" class="latest-project-link cms-project-card w-inline-block" aria-label="${escapeHtml(project.name)}">
                    <img src="${project.cover}" loading="lazy" alt="${escapeHtml(project.name)}" class="latest-project-img">
                    <div class="latest-project-link-description blur_background"><div class="text-block">${escapeHtml(project.name)}</div></div>
                    <div class="latest-project-link-shadow"></div>
                    <div class="latest-project-link-bottom-descr blur_background">
                      <div class="text">${escapeHtml(project.location)}</div>
                      <time class="text" datetime="${project.completionDate}">${formatDate(project.completionDate)}</time>
                    </div>
                  </a>
                </div>`).join('\n');
const indexPath = path.join(root, 'index.html');
let index = await fs.readFile(indexPath, 'utf8');
const listPattern = /<div class="latest__project-link-cms w-dyn-list"(?: id="latest-projects")?>[\s\S]*?(?=\n          <\/div>\n        <\/div>\n      <\/div>\n    <\/section>)/;
if (!listPattern.test(index)) throw new Error('Cannot find the home-page projects list');
index = index.replace(listPattern, `<div class="latest__project-link-cms w-dyn-list" id="latest-projects">\n              <div role="list" class="latest-project-grid-wraper w-dyn-items">\n${cards}\n              </div>\n            </div>`);
index = index.replace('href="#" class="footer-link">Latest Projects', 'href="index.html#latest-projects" class="footer-link">Latest Projects');
if (!index.includes('href="css/projects.css"')) index = index.replace('</head>', '  <link href="css/projects.css" rel="stylesheet">\n</head>');

const template = await fs.readFile(path.join(root, 'detail_latest-project.html'), 'utf8');
const sectionPattern = /<section class="section__hero-projects">[\s\S]*?<\/section>/;
if (!sectionPattern.test(template)) throw new Error('Cannot find the CMS project template');
for (const project of projects) {
  const gallery = project.gallery.length ? project.gallery : [project.cover];
  const section = `<section class="section__hero-projects">
      <div class="padding-global">
        <div class="w-layout-blockcontainer container-narrow w-container">
          <div class="breadcrumbs-wraper margin-s">
            <a href="index.html#latest-projects" class="breadcrumbs-link">Home</a>
            <p class="text text-dark" aria-hidden="true">/</p>
            <span class="breadcrumbs-link" aria-current="page">${escapeHtml(project.name)}</span>
          </div>
          <div class="projects__text-wraper">
            <div class="margin-s"><h1 class="h-4 text-dark">${escapeHtml(project.name)}</h1></div>
            <div class="projects__text-wraper-grid margin-s">
              <p class="text text-dark max-width-m margin-xs">${escapeHtml(project.shortDescription)}</p>
              <ul role="list" class="projects__list">
                <li class="projects__list-item"><span class="text-semi-bold">Location:</span> ${escapeHtml(project.location)}</li>
                <li class="projects__list-item"><span class="text-semi-bold">Completed:</span> <time datetime="${project.completionDate}">${formatDate(project.completionDate)}</time></li>
              </ul>
            </div>
          </div>
          <div class="lb__list-wraper margin-m">
            <div role="list" class="lb__cms is-ready">
${gallery.map((image, i) => `              <div role="listitem" class="lb__collection-item"><a href="${image}" class="lb__img-wrap cms-gallery-open" aria-label="Open ${escapeHtml(project.name)} photo ${i + 1}"><img src="${image}" loading="${i === 0 ? 'eager' : 'lazy'}" alt="${escapeHtml(project.name)} — photo ${i + 1}" class="lb-thumb"></a></div>`).join('\n')}
            </div>
          </div>
          <div class="text text-dark w-richtext">${project.fullDescription}</div>
          <div class="lb" role="dialog" aria-modal="true" aria-label="${escapeHtml(project.name)} photo gallery" aria-hidden="true">
            <div class="lb__backdrop"></div>
            <div class="lb__panel">
              <img src="${gallery[0]}" alt="${escapeHtml(project.name)}" class="lb__img">
              <button type="button" class="lb__close w-button">close</button>
              <button type="button" class="lb__prev w-button">previous</button>
              <button type="button" class="lb__next w-button">next</button>
              <div class="lb__counter" aria-live="polite"></div>
            </div>
          </div>
        </div>
      </div>
    </section>`;
  let page = template.replace(sectionPattern, section)
    .replace('<!DOCTYPE html>', '<!DOCTYPE html>\n<!-- Generated by scripts/import-projects.mjs -->')
    .replace('href="#" class="footer-link">Latest Projects', 'href="index.html#latest-projects" class="footer-link">Latest Projects')
    .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(project.name)} | Wooden Factory</title>`)
    .replace('</head>', `  <meta name="description" content="${escapeHtml(project.shortDescription)}">\n  <link href="css/projects.css" rel="stylesheet">\n</head>`);
  // The old template's gallery script/styles are replaced by the shared, accessible gallery.
  const oldGalleryStart = page.indexOf('  <style>\n.lb__cms { visibility: hidden; }');
  if (oldGalleryStart === -1) throw new Error('Cannot locate the old gallery script');
  page = page.slice(0, oldGalleryStart) + '  <script src="js/project-gallery.js" defer></script>\n</body>\n</html>\n';
  page = page.replace(/\b(href|src|srcset)="([^"]*)"/g, (match, attr, value) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value) || !value) return match;
    if (attr === 'srcset') return `${attr}="${value.split(',').map(item => '../../' + item.trim()).join(', ')}"`;
    return `${attr}="../../${value}"`;
  });
  const directory = path.join(root, 'latest-project', project.slug);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'index.html'), page);
}
for (const previous of previousProjects) {
  if (slugs.has(previous.slug)) continue;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(previous.slug)) throw new Error('Invalid previous project slug');
  const file = path.join(root, 'latest-project', previous.slug, 'index.html');
  try {
    const page = await fs.readFile(file, 'utf8');
    if (!page.includes('<!-- Generated by scripts/import-projects.mjs -->')) throw new Error(`Refusing to remove an unmanaged page: ${file}`);
    await fs.unlink(file);
    await fs.rmdir(path.dirname(file));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await fs.mkdir(path.join(root, 'data'), { recursive: true });
await fs.writeFile(path.join(root, 'data/projects.json'), JSON.stringify(projects, null, 2) + '\n');
const headers = Object.keys(inputRows[0]);
const csvCell = value => `"${String(value).replaceAll('"', '""')}"`;
const publicCsv = [headers, ...published.map(row => headers.map(key => row[key]))]
  .map(values => values.map(csvCell).join(',')).join('\n') + '\n';
await fs.writeFile(path.join(root, 'data/latest-projects.csv'), publicCsv);
await fs.writeFile(indexPath, index);
console.log(JSON.stringify({ records: inputRows.length, published: projects.length, galleryPhotos: projects.reduce((sum, p) => sum + p.gallery.length, 0), uniqueImages: assets.size, downloaded }, null, 2));
