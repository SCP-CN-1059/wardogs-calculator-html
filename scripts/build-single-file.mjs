/*
 * Builds one self-contained HTML file that runs the calculator straight from
 * the filesystem — no server, no Node, no internet.
 *
 *     node scripts/build-single-file.mjs
 *     node scripts/build-single-file.mjs --detail-radius-km 1 --quality 60
 *     node scripts/build-single-file.mjs --format webp --base-max-zoom 3
 *
 * What makes it self-contained:
 *
 *   - every stylesheet and script of src/pages/index.html is inlined;
 *   - the JSON the runtime asks for (config, locales, weapons, map
 *     configuration, marker registry, MOTD) is embedded as a registry that
 *     js/core/resources.js consults before touching the network;
 *   - marker artwork rides along as data URIs;
 *   - map imagery is embedded as tiles under the same
 *     "<map>:<style>:<zoom>:<x>:<y>" keys the renderer already uses.
 *
 * Imagery policy (measured, see docs/single-file.md):
 *
 *   z0..--base-max-zoom      the whole map, so panning and the Fit view work
 *   --detail-min-zoom..max   only inside the tower-cluster box
 *
 * Outside that box the renderer falls back to a cached lower-resolution
 * ancestor, which is exactly the "no high detail away from the fight" rule.
 *
 * Colour tiles are never embedded: the standalone build keeps the black &
 * white style only, and the inlined map configuration is rewritten to match so
 * the style picker cannot offer imagery the file does not carry.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const OPTIONS = {
    maps: null,
    detailRadiusKm: 1.5,
    baseMaxZoom: 4,
    detailMinZoom: 5,
    maxZoom: 7,
    quality: 65,
    format: 'jpeg',
    out: '炮兵计算器-单文件版.html',
    python: 'python',
    reencode: true,

    /*
     * The standalone file is deliberately a reduced calculator: one language,
     * one map style, no accessibility panel, no drawing tools, no
     * import/export and no announcement. Each name listed here turns the
     * matching feature back on; --full restores the complete interface.
     */
    features: [],
    languages: ['zh-cn'],
    allLanguages: false
};

const OPTIONAL_FEATURES = [
    'locales',
    'mapStyle',
    'accessibility',
    'drawingTools',
    'dataTransfer',
    'motd'
];

/*
 * Markup that disappears with a feature. The application guards every one of
 * these lookups, so pruning the node is enough — no script surgery needed.
 */
const FEATURE_MARKUP = {
    locales: ['id="language"', 'class="language-picker"'],

    drawingTools: [
        'id="mapToolPencil"',
        'id="mapToolEraser"',
        'id="mapToolMarker"',
        'id="pencilPalette"',
        'id="markerPicker"'
    ],

    dataTransfer: [
        'id="mapToolDataTransfer"',
        'id="mapDataTransferPopover"',
        'class="saved-target-transfer-actions"',
        'id="savedTargetsTransferStatus"'
    ]
};

/* The standalone file has no /mobile/ route, so phones keep the desktop UI. */
const DROPPED_SCRIPTS =
    new Set(['js/core/mobile-redirect.js']);

function parseArgs(argv) {
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--help' || arg === '-h') {
            console.log(
                [
                    'Usage: node scripts/build-single-file.mjs [options]',
                    '',
                    '  --maps <ids>            Comma separated map ids (default: all)',
                    '  --detail-radius-km <n>  High-detail box around the towers (default: 1.5)',
                    '  --base-max-zoom <n>     Full-map levels z0..n (default: 4)',
                    '  --detail-min-zoom <n>   First level inside the box (default: 5)',
                    '  --max-zoom <n>          Highest embedded level (default: 7)',
                    '  --quality <n>           JPEG/WebP quality (default: 65)',
                    '  --format <jpeg|webp>    Embedded image format (default: jpeg)',
                    '  --no-reencode           Embed the published WebP bytes unchanged',
                    '  --out <file>            Output file name (default: 炮兵计算器-单文件版.html)',
                    '  --python <exe>          Python interpreter with Pillow (default: python)',
                    '',
                    'Interface (the standalone build is Chinese-only and reduced by default):',
                    '',
                    '  --full                  Keep every optional feature and language',
                    '  --features <names>      Keep only these: locales,mapStyle,accessibility,',
                    '                          drawingTools,dataTransfer,motd',
                    '  --languages <ids>       Embedded languages (default: zh-cn)',
                    '  --all-languages         Embed every locale instead'
                ].join('\n')
            );

            process.exit(0);
        }

        if (arg === '--no-reencode') {
            OPTIONS.reencode = false;
            OPTIONS.format = 'raw';
            continue;
        }

        if (arg === '--full') {
            OPTIONS.features = [...OPTIONAL_FEATURES];
            OPTIONS.allLanguages = true;
            continue;
        }

        if (arg === '--all-languages') {
            OPTIONS.allLanguages = true;
            continue;
        }

        const [flag, inlineValue] = arg.split('=');
        const value = inlineValue ?? argv[index + 1];

        if (inlineValue === undefined) {
            index += 1;
        }

        if (value === undefined) {
            throw new Error(`Missing value for ${flag}`);
        }

        if (flag === '--maps') {
            OPTIONS.maps = String(value)
                .split(',')
                .map(item => item.trim())
                .filter(Boolean);
            continue;
        }

        if (flag === '--detail-radius-km') {
            OPTIONS.detailRadiusKm = Math.max(0.25, Number(value) || 1.5);
            continue;
        }

        if (flag === '--base-max-zoom') {
            OPTIONS.baseMaxZoom = Math.max(0, Math.min(7, Number(value) || 4));
            continue;
        }

        if (flag === '--detail-min-zoom') {
            OPTIONS.detailMinZoom = Math.max(0, Math.min(7, Number(value) || 5));
            continue;
        }

        if (flag === '--max-zoom') {
            OPTIONS.maxZoom = Math.max(0, Math.min(7, Number(value) || 7));
            continue;
        }

        if (flag === '--quality') {
            OPTIONS.quality = Math.max(20, Math.min(95, Number(value) || 65));
            continue;
        }

        if (flag === '--format') {
            const format = String(value).toLowerCase();

            if (!['jpeg', 'webp', 'raw'].includes(format)) {
                throw new Error(`Unsupported --format: ${value}`);
            }

            OPTIONS.format = format;
            continue;
        }

        if (flag === '--out') {
            OPTIONS.out = String(value);
            continue;
        }

        if (flag === '--python') {
            OPTIONS.python = String(value);
            continue;
        }

        if (flag === '--features') {
            const requested = String(value)
                .split(',')
                .map(item => item.trim())
                .filter(Boolean);

            const unknown = requested.filter(
                name => !OPTIONAL_FEATURES.includes(name)
            );

            if (unknown.length) {
                throw new Error(`Unknown feature(s): ${unknown.join(', ')}`);
            }

            OPTIONS.features = requested;
            continue;
        }

        if (flag === '--languages') {
            OPTIONS.languages = String(value)
                .split(',')
                .map(item => item.trim())
                .filter(Boolean);

            if (!OPTIONS.languages.length) {
                throw new Error('--languages needs at least one language id');
            }

            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }
}

function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    return `${(bytes / 1024).toFixed(0)} KB`;
}

async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

function stripTrailingSlashes(value) {
    return String(value || '').replace(/\/+$/, '');
}

/*
 * Everything after /releases/<release>/ is the checkout-relative path — the
 * same contract the offline mirror and the runtime resolver use.
 */
function releaseTail(url) {
    const text = stripTrailingSlashes(url);
    const match = text.match(/\/releases\/[^/]+\/(.+)$/);

    return match ? match[1] : text;
}

function isUsableBounds(bounds) {
    return Boolean(
        bounds &&
        Number.isFinite(Number(bounds.minX)) &&
        Number.isFinite(Number(bounds.maxX)) &&
        Number.isFinite(Number(bounds.minY)) &&
        Number.isFinite(Number(bounds.maxY)) &&
        bounds.maxX > bounds.minX &&
        bounds.maxY > bounds.minY
    );
}

function styleEntries(map) {
    const entries = Object.entries(map.tiles?.styles || {});

    return entries.length
        ? entries
        : [['default', map.tiles]];
}

/*
 * Only the black & white style is embedded. It is the default everywhere, and
 * carrying both would double a file whose size is dominated by pixels.
 */
function chosenStyle(map) {
    const entries = styleEntries(map);

    return (
        entries.find(([id]) => id === 'grayscale') ||
        entries.find(([id]) => id === map.tiles?.defaultStyle) ||
        entries[0]
    );
}

/*
 * The fight happens around the tower cluster, so that is where the detailed
 * levels are spent. The box is the tower markers' bounding box grown to the
 * requested radius, in map units (1 unit = 100 m on every published map).
 */
function towerBox(map) {
    const perUnit = Number(map.coordinateMetersPerUnit) || 100;

    const towers = (map.markers || [])
        .filter(marker => /tower/i.test(String(marker.label || '')))
        .map(marker => ({
            x: Number(marker.x) / perUnit,
            y: Number(marker.y) / perUnit
        }))
        .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));

    if (!towers.length) {
        return null;
    }

    const centre = towers.reduce(
        (accumulator, point) => ({
            x: accumulator.x + point.x / towers.length,
            y: accumulator.y + point.y / towers.length
        }),
        { x: 0, y: 0 }
    );

    const radius = OPTIONS.detailRadiusKm * 10;

    return {
        count: towers.length,
        centre,
        minX: centre.x - radius,
        maxX: centre.x + radius,
        minY: centre.y - radius,
        maxY: centre.y + radius
    };
}

function zoomGrid(map, zoom) {
    const bounds = isUsableBounds(map.tileBounds)
        ? map.tileBounds
        : map.bounds;

    const count = Math.pow(2, zoom);

    return {
        bounds,
        count,
        width: (bounds.maxX - bounds.minX) / count,
        height: (bounds.maxY - bounds.minY) / count
    };
}

function tileRange(map, zoom, box) {
    const grid = zoomGrid(map, zoom);

    return {
        x0: Math.max(0, Math.floor((box.minX - grid.bounds.minX) / grid.width)),
        x1: Math.min(grid.count - 1, Math.floor((box.maxX - grid.bounds.minX) / grid.width)),
        y0: Math.max(0, Math.floor((grid.bounds.maxY - box.maxY) / grid.height)),
        y1: Math.min(grid.count - 1, Math.floor((grid.bounds.maxY - box.minY) / grid.height))
    };
}

function planMap(entry) {
    const { map } = entry;
    const [styleId, style] = chosenStyle(map);
    const tail = releaseTail(style?.path || map.tiles?.path || '');

    if (!tail) {
        throw new Error(`${map.id}: no tile path in the map configuration`);
    }

    const extension = String(style.extension || map.tiles?.extension || 'webp')
        .replace(/^\./, '');

    const configuredMin = Number(map.tiles?.minZoom);
    const configuredMax = Number(map.tiles?.maxZoom);

    const minZoom = Number.isFinite(configuredMin) ? configuredMin : 0;
    const maxZoom = Number.isFinite(configuredMax) ? configuredMax : 5;

    const box = towerBox(map);
    const seen = new Set();
    const tiles = [];
    const missing = [];
    const levels = [];

    const add = (zoom, x, y) => {
        const key = `${map.id}:${styleId}:${zoom}:${x}:${y}`;

        if (seen.has(key)) {
            return;
        }

        seen.add(key);

        const relative = `${tail}/zoom_${zoom}/${x}_${y}.${extension}`;
        const absolute = resolve(root, relative.split('/').join(sep));

        if (!existsSync(absolute)) {
            missing.push(relative);
            return;
        }

        tiles.push({ key, path: relative });
    };

    /* Whole map, so every zoom level the camera can reach has something. */
    for (let zoom = minZoom; zoom <= Math.min(OPTIONS.baseMaxZoom, maxZoom); zoom += 1) {
        const side = Math.pow(2, zoom);
        const before = tiles.length;

        for (let y = 0; y < side; y += 1) {
            for (let x = 0; x < side; x += 1) {
                add(zoom, x, y);
            }
        }

        levels.push({
            zoom,
            scope: 'full map',
            tiles: tiles.length - before
        });
    }

    /* Detail levels, but only across the tower box. */
    if (box) {
        for (
            let zoom = Math.max(OPTIONS.detailMinZoom, minZoom);
            zoom <= Math.min(OPTIONS.maxZoom, maxZoom);
            zoom += 1
        ) {
            const range = tileRange(map, zoom, box);
            const before = tiles.length;

            for (let y = range.y0; y <= range.y1; y += 1) {
                for (let x = range.x0; x <= range.x1; x += 1) {
                    add(zoom, x, y);
                }
            }

            levels.push({
                zoom,
                scope: `${range.x1 - range.x0 + 1}x${range.y1 - range.y0 + 1} tower box`,
                tiles: tiles.length - before
            });
        }
    }

    return {
        map,
        styleId,
        tail,
        box,
        tiles,
        missing,
        levels
    };
}

/*
 * The inlined map configuration advertises exactly one style, so the picker
 * cannot select imagery the file does not carry.
 */
function inlineMapConfig(map, styleId) {
    const clone = JSON.parse(JSON.stringify(map));
    const style = clone.tiles?.styles?.[styleId] || clone.tiles;

    /*
     * Advertise the deepest level this file actually carries. The renderer then
     * asks for it directly instead of requesting a level that was never
     * embedded and falling back to an ancestor on every frame.
     */
    const configuredMax = Number(clone.tiles?.maxZoom);

    clone.tiles = {
        ...clone.tiles,
        maxZoom: Math.min(
            Number.isFinite(configuredMax)
                ? configuredMax
                : OPTIONS.maxZoom,
            OPTIONS.maxZoom
        ),
        styles: {
            [styleId]: {
                path: style.path
            }
        },
        defaultStyle: styleId
    };

    return clone;
}

async function loadSourceMaps() {
    const index = await readJson(join(root, 'maps', 'index.json'));

    const files = Array.isArray(index)
        ? index
        : Array.isArray(index.maps)
            ? index.maps
            : [];

    const selected = [];
    const registeredFiles = [];

    for (const entry of files) {
        const file = typeof entry === 'string' ? entry : entry.file;

        if (!file) {
            continue;
        }

        const map = await readJson(join(root, 'maps', file));

        if (OPTIONS.maps && !OPTIONS.maps.includes(map.id)) {
            continue;
        }

        selected.push({ file, map });
        registeredFiles.push(file);
    }

    if (!selected.length) {
        throw new Error('No maps matched the requested --maps filter');
    }

    return { selected, registeredFiles };
}

async function loadLocaleRegistry(languageIds) {
    const index = await readJson(join(root, 'locales', 'index.json'));

    const languages = (index.languages || []).filter(
        language => !languageIds || languageIds.includes(language.id)
    );

    if (!languages.length) {
        throw new Error(
            `None of the requested languages exist: ${(languageIds || []).join(', ')}`
        );
    }

    const catalogs = {};

    for (const language of languages) {
        if (!language?.file) {
            continue;
        }

        const path = join(root, 'locales', language.file);

        if (!existsSync(path)) {
            continue;
        }

        catalogs[language.id] = await readJson(path);
    }

    return {
        languages,
        catalogs,
        index: {
            ...index,
            default: languages.length === 1 ? languages[0].id : index.default,
            languages
        }
    };
}

/*
 * Removes an element and everything inside it by matching its opening tag.
 * Nesting is counted per tag name, so a button with an inline SVG disappears
 * whole rather than leaving its icon behind.
 */
function removeElement(html, attributePattern) {
    const openPattern = new RegExp(
        `<([a-z][a-z0-9]*)\\b[^>]*\\b${attributePattern}[^>]*>`,
        'i'
    );

    const match = html.match(openPattern);

    if (!match) {
        return html;
    }

    const tag = match[1];
    const start = match.index;
    const openTag = match[0];

    if (openTag.endsWith('/>')) {
        return html.slice(0, start) + html.slice(start + openTag.length);
    }

    const tagPattern = new RegExp(`<${tag}\\b|</${tag}\\s*>`, 'gi');
    tagPattern.lastIndex = start;

    let depth = 0;
    let step = tagPattern.exec(html);

    while (step !== null) {
        if (step[0].startsWith('</')) {
            depth -= 1;

            if (depth === 0) {
                return html.slice(0, start) + html.slice(tagPattern.lastIndex);
            }
        } else {
            depth += 1;
        }

        step = tagPattern.exec(html);
    }

    return html;
}

/*
 * The standalone file is a local tool, not an indexed page: SEO metadata is
 * dropped, and the shell is labelled with the language it is locked to.
 */
function localizeHead(html, languageId, title) {
    let result = html;

    /* The BCP 47 form is what the lang attribute wants; the id is what the
       application reads back from data-page-language. */
    const htmlLanguage = languageId === 'zh-cn'
        ? 'zh-CN'
        : languageId;

    result = result.replace(
        /<html\b[^>]*>/i,
        `<html data-page-language="${languageId}" lang="${htmlLanguage}">`
    );

    if (title) {
        result = result.replace(
            /<title>[\s\S]*?<\/title>/i,
            `<title>${title}</title>`
        );
    }

    result = result.replace(
        /<meta\b[^>]*\bname=["'](?:description|robots|yandex-verification|google-site-verification)["'][^>]*>\s*/gi,
        ''
    );

    result = result.replace(
        /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>\s*/gi,
        ''
    );

    return result;
}

function expandStyleSheet(css, seen = new Set()) {
    return css.replace(
        /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)\s*;?/gi,
        (match, href) => {
            if (/^https?:/i.test(href)) {
                return '';
            }

            const target = resolve(root, href.replace(/^\.\//, ''));

            if (seen.has(target)) {
                return '';
            }

            seen.add(target);

            if (!existsSync(target)) {
                console.warn(`Stylesheet import not found: ${href}`);

                return '';
            }

            return expandStyleSheet(
                readFileSync(target, 'utf8'),
                seen
            );
        }
    );
}

/*
 * Escapes are unnecessary: no application file contains a literal closing
 * script tag, and the JSON payloads cannot produce one. The check below keeps
 * that guarantee honest if the sources ever change.
 */
function guardScriptBody(code, label) {
    if (code.includes('</script')) {
        throw new Error(`${label} contains a closing script tag and cannot be inlined`);
    }

    return code;
}

async function main() {
    parseArgs(process.argv.slice(2));

    const started = Date.now();

    console.log('');
    console.log('WARDOGS standalone build');
    console.log(`Checkout: ${root}`);
    console.log('');

    const { selected, registeredFiles } = await loadSourceMaps();
    const plans = selected.map(planMap);

    const tileCount = plans.reduce((sum, plan) => sum + plan.tiles.length, 0);
    const missingCount = plans.reduce((sum, plan) => sum + plan.missing.length, 0);

    console.log('Tile selection:');

    for (const plan of plans) {
        const box = plan.box;

        console.log(
            `  ${plan.map.id}/${plan.styleId}: ${plan.tiles.length} tiles` +
            (box
                ? ` · tower box ${(box.maxX - box.minX).toFixed(1)}x${(box.maxY - box.minY).toFixed(1)} units around (${box.centre.x.toFixed(1)}, ${box.centre.y.toFixed(1)})`
                : ' · no tower markers, full map only')
        );

        for (const level of plan.levels) {
            console.log(`      z${level.zoom}: ${String(level.tiles).padStart(5)} tiles (${level.scope})`);
        }

        for (const missing of plan.missing.slice(0, 5)) {
            console.log(`      missing: ${missing}`);
        }
    }

    console.log('');

    if (missingCount) {
        console.log(`WARN ${missingCount} selected tiles are not in the mirror (run npm run mirror).`);
        console.log('');
    }

    /* ---------------------------------------------------------------
     * Registry
     * --------------------------------------------------------------- */

    const appConfig = await readJson(join(root, 'config', 'app.json'));

    appConfig.offline = {
        enabled: true,
        note: 'Standalone build: every asset is embedded, nothing is requested over the network.'
    };

    appConfig.collab = { enabled: false };
    appConfig.feedback = { enabled: false };

    /* ---------------------------------------------------------------
     * Interface scope
     * --------------------------------------------------------------- */

    const localeSet = await loadLocaleRegistry(
        OPTIONS.allLanguages ? null : OPTIONS.languages
    );

    const lockedLanguage = localeSet.languages.length === 1
        ? localeSet.languages[0].id
        : '';

    const featureFlags = Object.fromEntries(
        OPTIONAL_FEATURES.map(name => [name, OPTIONS.features.includes(name)])
    );

    console.log(
        `Interface: languages=${localeSet.languages.map(language => language.id).join(',')}` +
        `${lockedLanguage ? ' (locked)' : ''} · ` +
        `features=${OPTIONS.features.length ? OPTIONS.features.join(',') : 'none'}`
    );
    console.log('');

    const inlineJsonRegistry = {
        'config/app.json': appConfig,
        'data/weapons.json': await readJson(join(root, 'data', 'weapons.json')),
        'maps/index.json': registeredFiles,
        'maps/assets.json': await readJson(join(root, 'maps', 'assets.json')),
        'locales/index.json': localeSet.index
    };

    for (const language of localeSet.languages) {
        if (localeSet.catalogs[language.id]) {
            inlineJsonRegistry[`locales/${language.file}`] = localeSet.catalogs[language.id];
        }
    }

    const motdPath = join(root, 'data', 'motd.json');

    if (featureFlags.motd && existsSync(motdPath)) {
        inlineJsonRegistry['data/motd.json'] = await readJson(motdPath);
    }

    for (const plan of plans) {
        inlineJsonRegistry[`maps/${plan.map.id}.json`] = inlineMapConfig(plan.map, plan.styleId);

        const registered = registeredFiles.indexOf(`${plan.map.id}.json`);

        if (registered === -1) {
            registeredFiles.push(`${plan.map.id}.json`);
        }
    }

    /* Marker artwork and the favicon are tiny; embed them as they are. */
    const assets = inlineJsonRegistry['maps/assets.json'];
    const filePaths = new Set(['assets/favicon.png']);

    for (const asset of Object.values(assets.markerIcons || {})) {
        const path = typeof asset === 'string' ? asset : asset?.path;

        if (path) {
            filePaths.add(path);
        }
    }

    const inlineFiles = {};

    for (const path of filePaths) {
        const absolute = resolve(root, path.split('/').join(sep));

        if (!existsSync(absolute)) {
            console.warn(`Asset not found, skipping: ${path}`);

            continue;
        }

        const bytes = await readFile(absolute);
        const mime = extname(path).toLowerCase() === '.png'
            ? 'image/png'
            : extname(path).toLowerCase() === '.svg'
                ? 'image/svg+xml'
                : 'image/webp';

        inlineFiles[path] = `data:${mime};base64,${bytes.toString('base64')}`;
    }

    console.log(`Embedded assets: ${Object.keys(inlineFiles).length} marker/favicon files`);

    /* ---------------------------------------------------------------
     * Tile pixels
     * --------------------------------------------------------------- */

    const tileTasks = plans.flatMap(plan => plan.tiles);
    const tilesJsonPath = join(tmpdir(), `wardogs-single-tiles-${Date.now()}.json`);

    let encoded = null;

    if (OPTIONS.reencode && tileTasks.length) {
        const jobPath = join(tmpdir(), `wardogs-single-job-${Date.now()}.json`);

        await writeFile(
            jobPath,
            JSON.stringify({
                root,
                format: OPTIONS.format,
                quality: OPTIONS.quality,
                tiles: tileTasks
            })
        );

        console.log(
            `Encoding ${tileTasks.length} tiles as ${OPTIONS.format} q${OPTIONS.quality} with Pillow…`
        );

        const result = spawnSync(
            OPTIONS.python,
            [join(root, 'scripts', 'lib', 'single-file-tiles.py'), jobPath, tilesJsonPath],
            { encoding: 'utf8' }
        );

        if (result.status !== 0) {
            console.error(result.stdout || '');
            console.error(result.stderr || '');

            throw new Error(
                `Python tile encoding failed (exit ${result.status}). ` +
                'Install Pillow, or build with --no-reencode.'
            );
        }

        encoded = JSON.parse(result.stdout.trim().split('\n').pop());

        await stat(tilesJsonPath);
    } else {
        console.log('Embedding the published WebP bytes unchanged (--no-reencode).');

        const raw = {};

        for (const task of tileTasks) {
            const bytes = await readFile(resolve(root, task.path.split('/').join(sep)));

            raw[task.key] = `data:image/webp;base64,${bytes.toString('base64')}`;
        }

        await writeFile(tilesJsonPath, JSON.stringify(raw));
    }

    const tilesJsonText = await readFile(tilesJsonPath, 'utf8');

    /* ---------------------------------------------------------------
     * HTML assembly
     * --------------------------------------------------------------- */

    let html = await readFile(join(root, 'src', 'pages', 'index.html'), 'utf8');

    /* Local shell metadata: the standalone build is not an indexed page. */
    html = localizeHead(
        html,
        lockedLanguage || 'en',
        localeSet.catalogs[lockedLanguage]?.title || ''
    );

    /* Remove the markup of every feature this build leaves out. */
    const pruned = [];

    for (const feature of OPTIONAL_FEATURES) {
        if (featureFlags[feature]) {
            continue;
        }

        for (const pattern of FEATURE_MARKUP[feature] || []) {
            const before = html;

            html = removeElement(html, pattern);

            if (html !== before) {
                pruned.push(`${feature}:${pattern}`);
            }
        }
    }

    if (pruned.length) {
        console.log(`Removed markup: ${pruned.length} element(s)`);
    }

    /* Inert offline: keep the page from pointing at production SEO URLs. */
    html = html.replace(/<link\b[^>]*\brel=["'](?:canonical|alternate)["'][^>]*>\s*/gi, '');

    /* The favicon travels inside the file. */
    html = html.replace(/assets\/favicon\.png/g, inlineFiles['assets/favicon.png'] || 'assets/favicon.png');

    /* Stylesheets, with their @import chain expanded. */
    html = html.replace(
        /<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi,
        tag => {
            const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];

            if (!href) {
                return '';
            }

            const absolute = resolve(root, href.replace(/^\.\//, ''));

            if (!existsSync(absolute)) {
                console.warn(`Stylesheet not found: ${href}`);

                return '';
            }

            return `<style>\n${expandStyleSheet(readFileSync(absolute, 'utf8'))}\n</style>`;
        }
    );

    /* Application scripts, in page order. */
    const inlinedScripts = [];

    html = html.replace(
        /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
        (tag, src) => {
            if (/^https?:/i.test(src)) {
                return '';
            }

            if (DROPPED_SCRIPTS.has(src)) {
                return '';
            }

            const absolute = resolve(root, src.replace(/^\.\//, ''));

            if (!existsSync(absolute)) {
                throw new Error(`Script not found: ${src}`);
            }

            inlinedScripts.push(src);

            return `<script>\n${guardScriptBody(readFileSync(absolute, 'utf8'), src)}\n</script>`;
        }
    );

    const registryScript = [
        '<script>',
        'window.__WARDOGS_ANALYTICS_DISABLED__ = true;',

        /* Feature switches and the locked language, read by js/core/core.js. */
        `window.__WARDOGS_FEATURES__ = ${JSON.stringify(featureFlags)};`,

        ...(lockedLanguage
            ? [`window.__WARDOGS_LANGUAGE__ = ${JSON.stringify(lockedLanguage)};`]
            : []),

        `window.__WARDOGS_INLINE__ = ${JSON.stringify({
            single: true,

            /*
             * Tells the renderer which level covers the whole map, so a view
             * away from the towers can request it instead of showing a dark
             * placeholder.
             */
            baseZoom: Object.fromEntries(
                plans.map(plan => [
                    plan.map.id,
                    Math.min(
                        OPTIONS.baseMaxZoom,
                        Number.isFinite(Number(plan.map.tiles?.maxZoom))
                            ? Number(plan.map.tiles.maxZoom)
                            : OPTIONS.baseMaxZoom
                    )
                ])
            ),
            json: inlineJsonRegistry,
            files: inlineFiles
        })};`,
        `window.__WARDOGS_INLINE__.tiles = ${tilesJsonText};`,
        '</script>'
    ].join('\n');

    html = html.replace('</head>', `${registryScript}\n</head>`);

    const outPath = resolve(root, OPTIONS.out);

    await writeFile(outPath, html, 'utf8');

    const written = await stat(outPath);

    console.log('');
    console.log(`Inlined scripts: ${inlinedScripts.length}`);
    console.log(`Embedded tiles:  ${tileTasks.length}`);

    if (encoded) {
        console.log(
            `Tile payload:    ${formatBytes(encoded.sourceBytes)} source -> ` +
            `${formatBytes(encoded.encodedBytes)} ${OPTIONS.format}`
        );
    }

    console.log(`File:            ${outPath}`);
    console.log(`Size:            ${formatBytes(written.size)}`);
    console.log(`Built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log('');
    console.log('Open it directly in a browser — no server and no network needed.');
    console.log('');
}

main().catch(error => {
    console.error('');
    console.error('Standalone build failed:', error.message);
    console.error('');
    process.exitCode = 1;
});
