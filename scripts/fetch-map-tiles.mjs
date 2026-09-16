/*
 * Mirrors every asset the calculator needs from the asset CDN into the
 * checkout, so the application can run with no internet connection.
 *
 *     node scripts/fetch-map-tiles.mjs                 # every map, every style, tiles only
 *     node scripts/fetch-map-tiles.mjs --terrain       # also Terrain3D manifests + chunks
 *     node scripts/fetch-map-tiles.mjs --styles grayscale
 *     node scripts/fetch-map-tiles.mjs --maps bakurani,ozeti
 *     node scripts/fetch-map-tiles.mjs --verify        # check the mirror, download nothing
 *     node scripts/fetch-map-tiles.mjs --force         # re-download files that already exist
 *
 * The mirror keeps the exact release layout below /maps and /data, which is
 * what js/core/resources.js resolves against when offline mode is enabled:
 *
 *     https://assets.wardogs-artillery.com/releases/assets-v1/maps/tiles/bakurani/zoom_3/2_1.webp
 *  -> maps/tiles/bakurani/zoom_3/2_1.webp
 *
 * Downloads are resumable: an existing non-empty file is skipped, so the
 * script can simply be re-run after an interruption. Tiles that the release
 * does not publish (HTTP 404) are counted as absent rather than as errors.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const OPTIONS = {
    concurrency: 40,
    retries: 4,
    styles: null,
    maps: null,
    terrain: false,
    terrainOnly: false,
    verify: false,
    force: false,
    limit: 0
};

const REPORT_PATH = join(root, 'offline-mirror-report.json');

function parseArgs(argv) {
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--help' || arg === '-h') {
            console.log(
                [
                    'Usage: node scripts/fetch-map-tiles.mjs [options]',
                    '',
                    '  --styles <ids>     Comma separated style ids (default: all styles)',
                    '  --maps <ids>       Comma separated map ids (default: maps/index.json)',
                    '  --concurrency <n>  Parallel requests (default: 40)',
                    '  --retries <n>      Attempts per file (default: 4)',
                    '  --terrain          Also mirror Terrain3D manifests and chunks',
                    '  --terrain-only     Mirror only Terrain3D data, skip tile pyramids',
                    '  --verify           Only check what is already mirrored',
                    '  --force            Re-download files that already exist',
                    '  --limit <n>        Stop after n tiles per pyramid (harness smoke test)'
                ].join('\n')
            );

            process.exit(0);
        }

        if (arg === '--terrain') {
            OPTIONS.terrain = true;
            continue;
        }

        if (arg === '--terrain-only') {
            OPTIONS.terrain = true;
            OPTIONS.terrainOnly = true;
            continue;
        }

        if (arg === '--verify') {
            OPTIONS.verify = true;
            continue;
        }

        if (arg === '--force') {
            OPTIONS.force = true;
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

        if (flag === '--styles') {
            OPTIONS.styles = splitList(value);
            continue;
        }

        if (flag === '--maps') {
            OPTIONS.maps = splitList(value);
            continue;
        }

        if (flag === '--concurrency') {
            OPTIONS.concurrency = Math.max(1, Math.min(128, Number(value) || 40));
            continue;
        }

        if (flag === '--retries') {
            OPTIONS.retries = Math.max(1, Math.min(10, Number(value) || 4));
            continue;
        }

        if (flag === '--limit') {
            OPTIONS.limit = Math.max(0, Number(value) || 0);
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }
}

function splitList(value) {
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function stripTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

/*
 * The release prefix is the storage contract shared with the runtime:
 * everything after /releases/<release>/ is the checkout-relative path.
 */
function releaseTail(url) {
    const match = String(url || '').match(/\/releases\/[^/]+\/(.+)$/);

    return match
        ? stripTrailingSlash(match[1])
        : null;
}

function localPathFor(tail) {
    const absolute = resolve(root, tail.split('/').join(sep));

    if (!absolute.startsWith(root)) {
        throw new Error(`Release path escapes the checkout: ${tail}`);
    }

    return absolute;
}

function relativeToRoot(path) {
    return relative(root, path).replaceAll('\\', '/');
}

async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

async function existingFileInfo(path) {
    try {
        const info = await stat(path);

        return info.isFile() && info.size > 0
            ? info
            : null;
    } catch {
        return null;
    }
}

function sleep(ms) {
    return new Promise(resolve_ => setTimeout(resolve_, ms));
}

function formatBytes(bytes) {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return '--';
    }

    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);

    return minutes > 0
        ? `${minutes}m ${String(total % 60).padStart(2, '0')}s`
        : `${total}s`;
}

async function runPool(items, concurrency, worker) {
    let cursor = 0;

    const runners = Array.from(
        {
            length: Math.max(
                1,
                Math.min(concurrency, items.length)
            )
        },
        async () => {
            while (cursor < items.length) {
                const item = items[cursor];
                cursor += 1;

                await worker(item);
            }
        }
    );

    await Promise.all(runners);
}

function isAbsentStatus(status) {
    return status === 404 || status === 410;
}

async function fetchToFile(task, stats) {
    if (!OPTIONS.force) {
        const existing = await existingFileInfo(task.file);

        if (existing) {
            if (task.bytes && existing.size !== task.bytes) {
                stats.corrupt.push({
                    path: relativeToRoot(task.file),
                    reason: `size ${existing.size} != ${task.bytes}`
                });
            } else {
                stats.skipped += 1;
                stats.bytes += existing.size;
                return true;
            }
        }
    }

    await mkdir(dirname(task.file), { recursive: true });

    for (let attempt = 1; attempt <= OPTIONS.retries; attempt += 1) {
        try {
            const response = await fetch(task.url, { redirect: 'follow' });

            if (isAbsentStatus(response.status)) {
                stats.absent.push(task.url);
                return false;
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const buffer = Buffer.from(await response.arrayBuffer());

            if (!buffer.length) {
                throw new Error('empty body');
            }

            if (task.bytes && buffer.length !== task.bytes) {
                throw new Error(`size ${buffer.length} != ${task.bytes}`);
            }

            if (task.sha256) {
                const digest = createHash('sha256')
                    .update(buffer)
                    .digest('hex');

                if (digest !== task.sha256) {
                    throw new Error('sha256 mismatch');
                }
            }

            await writeFile(task.file, buffer);

            stats.downloaded += 1;
            stats.bytes += buffer.length;

            return true;
        } catch (error) {
            if (attempt >= OPTIONS.retries) {
                stats.failed.push({
                    url: task.url,
                    error: String(error?.message || error)
                });

                return false;
            }

            await sleep(200 * attempt + Math.floor(Math.random() * 150));
        }
    }

    return false;
}

/*
 * Progress is printed as whole lines rather than with carriage returns so the
 * log stays readable when the script is run as a background job.
 */
function startProgress(label, total, stats) {
    let lastBytes = 0;
    let lastAt = Date.now();

    const timer = setInterval(
        () => {
            const now = Date.now();
            const elapsed = (now - lastAt) / 1000;
            const rate = elapsed > 0
                ? (stats.bytes - lastBytes) / elapsed
                : 0;

            lastBytes = stats.bytes;
            lastAt = now;

            const done = stats.downloaded + stats.skipped + stats.absent.length + stats.failed.length;
            const remaining = Math.max(0, total - done);
            const average = done > 0 ? stats.bytes / done : 0;

            console.log(
                `     ${label} ${done}/${total} · ${formatBytes(stats.bytes)} · ` +
                `${formatBytes(rate)}/s · absent ${stats.absent.length} · ` +
                `failed ${stats.failed.length} · eta ` +
                `${formatDuration(rate > 0 && average > 0 ? remaining * average / rate : NaN)}`
            );
        },
        15000
    );

    return () => clearInterval(timer);
}

async function loadPyramids() {
    const index = await readJson(join(root, 'maps', 'index.json'));

    const files = Array.isArray(index)
        ? index
        : Array.isArray(index.maps)
            ? index.maps
            : [];

    const registered = [];

    for (const entry of files) {
        const file = typeof entry === 'string' ? entry : entry.file;

        if (!file) {
            continue;
        }

        const map = await readJson(join(root, 'maps', file));

        if (!map.id) {
            continue;
        }

        if (OPTIONS.maps && !OPTIONS.maps.includes(map.id)) {
            continue;
        }

        registered.push(map);
    }

    if (!registered.length) {
        throw new Error('No maps matched the requested --maps filter');
    }

    const pyramids = [];

    for (const map of registered) {
        const styles = map.tiles?.styles && Object.keys(map.tiles.styles).length
            ? Object.entries(map.tiles.styles).map(
                ([id, style]) => ({
                    id,
                    config: {
                        ...map.tiles,
                        ...style
                    }
                })
            )
            : [{ id: map.tiles?.defaultStyle || 'default', config: map.tiles }];

        for (const style of styles) {
            if (OPTIONS.styles && !OPTIONS.styles.includes(style.id)) {
                continue;
            }

            if (!style.config?.path) {
                continue;
            }

            const tail = releaseTail(style.config.path);

            if (!tail) {
                console.log(
                    `Skipping ${map.id}/${style.id}: "${style.config.path}" is not a release URL.`
                );

                continue;
            }

            const tileSize = Number(style.config.tileSize) || 256;
            const minZoom = Number.isFinite(Number(style.config.minZoom))
                ? Number(style.config.minZoom)
                : 0;
            const maxZoom = Number.isFinite(Number(style.config.maxZoom))
                ? Number(style.config.maxZoom)
                : 5;
            const extension = String(style.config.extension || 'webp').replace(/^\./, '');

            pyramids.push({
                mapId: map.id,
                styleId: style.id,
                url: stripTrailingSlash(style.config.path),
                directory: localPathFor(tail),
                minZoom,
                maxZoom,
                tileSize,
                extension,
                total: tileCount(minZoom, maxZoom)
            });
        }
    }

    if (!pyramids.length) {
        throw new Error('No tile pyramids matched the requested filters');
    }

    return pyramids;
}

function tileCount(minZoom, maxZoom) {
    let total = 0;

    for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
        total += Math.pow(2, zoom) ** 2;
    }

    return total;
}

function tileTasks(pyramid) {
    const tasks = [];

    for (let zoom = pyramid.minZoom; zoom <= pyramid.maxZoom; zoom += 1) {
        const side = Math.pow(2, zoom);

        for (let y = 0; y < side; y += 1) {
            for (let x = 0; x < side; x += 1) {
                tasks.push({
                    url: `${pyramid.url}/zoom_${zoom}/${x}_${y}.${pyramid.extension}`,
                    file: join(pyramid.directory, `zoom_${zoom}`, `${x}_${y}.${pyramid.extension}`)
                });
            }
        }
    }

    return tasks;
}

function createStats() {
    return {
        downloaded: 0,
        skipped: 0,
        bytes: 0,
        absent: [],
        failed: [],
        corrupt: []
    };
}

async function mirrorPyramid(pyramid) {
    const tasks = tileTasks(pyramid);
    const stats = createStats();

    if (OPTIONS.limit > 0) {
        tasks.length = Math.min(tasks.length, OPTIONS.limit);
    }

    if (OPTIONS.verify) {
        for (const task of tasks) {
            const info = await existingFileInfo(task.file);

            if (info) {
                stats.skipped += 1;
                stats.bytes += info.size;
            } else {
                stats.absent.push(task.url);
            }
        }

        reportPyramid(pyramid, stats, true);

        return stats;
    }

    const stopProgress = startProgress(
        `${pyramid.mapId}/${pyramid.styleId}`,
        tasks.length,
        stats
    );

    try {
        await runPool(
            tasks,
            OPTIONS.concurrency,
            task => fetchToFile(task, stats)
        );
    } finally {
        stopProgress();
    }

    reportPyramid(pyramid, stats, false);

    return stats;
}

function reportPyramid(pyramid, stats, verifying) {
    const present = stats.skipped + stats.downloaded;
    const label = `${pyramid.mapId}/${pyramid.styleId} (zoom ${pyramid.minZoom}-${pyramid.maxZoom})`;

    if (verifying) {
        console.log(
            `${present === pyramid.total ? 'OK  ' : 'WARN'} ${label}: ` +
            `${present}/${pyramid.total} tiles mirrored · ${formatBytes(stats.bytes)} · ` +
            `missing ${stats.absent.length}`
        );

        return;
    }

    console.log(
        `     ${label}: ${present}/${pyramid.total} tiles ` +
        `(${stats.downloaded} new, ${stats.skipped} present) · ${formatBytes(stats.bytes)}` +
        (stats.absent.length ? ` · ${stats.absent.length} not published by the release` : '') +
        (stats.failed.length ? ` · ${stats.failed.length} FAILED` : '')
    );
}

async function mirrorTerrain() {
    const contextPath = join(root, 'data', 'ballistics', 'terrain-context.json');
    const context = await readJson(contextPath);

    const definitions = Object.entries(context.terrainMaps || {})
        .map(([mapId, definition]) => ({
            mapId,
            manifestUrl: stripTrailingSlash(definition?.terrainManifest || '')
        }))
        .filter(definition => definition.manifestUrl)
        .filter(definition => !OPTIONS.maps || OPTIONS.maps.includes(definition.mapId));

    if (!definitions.length) {
        console.log('No Terrain3D manifests are registered for the selected maps.');

        return [];
    }

    const results = [];

    for (const definition of definitions) {
        const tail = releaseTail(definition.manifestUrl);

        if (!tail) {
            console.log(`Skipping terrain for ${definition.mapId}: not a release URL.`);

            continue;
        }

        const manifestFile = localPathFor(tail);
        const stats = createStats();
        const manifestStats = createStats();

        if (!OPTIONS.verify || !(await existingFileInfo(manifestFile))) {
            await fetchToFile(
                {
                    url: definition.manifestUrl,
                    file: manifestFile
                },
                manifestStats
            );
        }

        if (!(await existingFileInfo(manifestFile)) && !OPTIONS.verify) {
            console.log(`WARN ${definition.mapId}: terrain manifest could not be downloaded`);

            results.push(manifestStats);
            continue;
        }

        let manifest = null;

        try {
            manifest = await readJson(manifestFile);
        } catch (error) {
            console.log(`WARN ${definition.mapId}: unreadable manifest (${error.message})`);

            results.push(manifestStats);
            continue;
        }

        /*
         * chunk.file is relative to the directory holding the manifest, not to
         * the manifest file itself:
         *
         *   <release>/data/terrain/bakurani/manifest.json
         *   <release>/data/terrain/bakurani/chunks/16_12.bin
         */
        const base = stripTrailingSlash(definition.manifestUrl)
            .replace(/\/[^/]*$/, '');

        const chunkTasks = Object.values(manifest.chunks || {})
            .filter(chunk => chunk?.file)
            .map(chunk => ({
                url: `${base}/${String(chunk.file).replace(/^\.?\//, '')}`,
                file: join(dirname(manifestFile), ...String(chunk.file).split('/')),
                bytes: Number(chunk.bytes) || 0,
                sha256: chunk.sha256 || ''
            }));

        if (OPTIONS.verify) {
            for (const task of chunkTasks) {
                const info = await existingFileInfo(task.file);

                if (!info) {
                    stats.absent.push(task.url);
                    continue;
                }

                const digest = createHash('sha256')
                    .update(await readFile(task.file))
                    .digest('hex');

                if (task.sha256 && digest !== task.sha256) {
                    stats.corrupt.push({
                        path: relativeToRoot(task.file),
                        reason: 'sha256 mismatch'
                    });

                    continue;
                }

                stats.skipped += 1;
                stats.bytes += info.size;
            }
        } else {
            const stopProgress = startProgress(
                `terrain/${definition.mapId}`,
                chunkTasks.length,
                stats
            );

            try {
                await runPool(
                    chunkTasks,
                    Math.min(OPTIONS.concurrency, 16),
                    task => fetchToFile(task, stats)
                );
            } finally {
                stopProgress();
            }
        }

        const present = stats.skipped + stats.downloaded;

        console.log(
            `${OPTIONS.verify && present !== chunkTasks.length ? 'WARN' : 'OK  '} terrain/${definition.mapId}: ` +
            `${present}/${chunkTasks.length} chunks · ${formatBytes(stats.bytes)}` +
            (stats.failed.length ? ` · ${stats.failed.length} FAILED` : '') +
            (stats.corrupt.length ? ` · ${stats.corrupt.length} CORRUPT` : '')
        );

        results.push(stats);
        results.push(manifestStats);
    }

    return results;
}

async function main() {
    parseArgs(process.argv.slice(2));

    const started = Date.now();

    console.log('');
    console.log(
        OPTIONS.verify
            ? 'WARDOGS offline mirror — verification'
            : 'WARDOGS offline mirror — download'
    );
    console.log(`Checkout: ${root}`);
    console.log('');

    const pyramids = OPTIONS.terrainOnly
        ? []
        : await loadPyramids();

    if (pyramids.length) {
        console.log(
            `Pyramids: ${pyramids.length} · tiles: ${pyramids
                .reduce((sum, pyramid) => sum + pyramid.total, 0)
                .toLocaleString('en-US')}`
        );
        console.log('');
    }

    const tileStats = [];

    for (const pyramid of pyramids) {
        tileStats.push(await mirrorPyramid(pyramid));
    }

    const terrainStats = OPTIONS.terrain
        ? await mirrorTerrain()
        : [];

    const all = [...tileStats, ...terrainStats];

    const totals = all.reduce(
        (accumulator, stats) => ({
            downloaded: accumulator.downloaded + stats.downloaded,
            skipped: accumulator.skipped + stats.skipped,
            bytes: accumulator.bytes + stats.bytes,
            absent: accumulator.absent.concat(stats.absent),
            failed: accumulator.failed.concat(stats.failed),
            corrupt: accumulator.corrupt.concat(stats.corrupt)
        }),
        createStats()
    );

    console.log('');
    console.log(
        `${OPTIONS.verify ? 'Mirrored' : 'Complete'}: ` +
        `${(totals.downloaded + totals.skipped).toLocaleString('en-US')} files · ` +
        `${formatBytes(totals.bytes)} · ` +
        `${formatDuration((Date.now() - started) / 1000)}`
    );

    if (totals.absent.length) {
        console.log(`Not published by the release: ${totals.absent.length}`);
    }

    if (totals.corrupt.length) {
        console.log(`Corrupt or truncated: ${totals.corrupt.length}`);
    }

    if (totals.failed.length) {
        console.log(`Failed: ${totals.failed.length} (re-run the script to retry them)`);

        for (const failure of totals.failed.slice(0, 10)) {
            console.log(`  ${failure.url} — ${failure.error}`);
        }
    }

    console.log('');

    /*
     * The report is written for download and verification runs alike: a scoped
     * run (--maps/--styles/--terrain-only/--limit) records the scope it
     * covered, so a partial report cannot be mistaken for a full snapshot.
     */
    await writeFile(
        REPORT_PATH,
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                mode: OPTIONS.verify ? 'verify' : 'download',
                scope: {
                    maps: OPTIONS.maps || 'all',
                    styles: OPTIONS.styles || 'all',
                    terrain: OPTIONS.terrain,
                    terrainOnly: OPTIONS.terrainOnly,
                    limitPerPyramid: OPTIONS.limit || 0
                },
                bytes: totals.bytes,
                files: totals.downloaded + totals.skipped,
                notPublished: totals.absent.length,
                failed: totals.failed,
                corrupt: totals.corrupt,
                pyramids: pyramids.map((pyramid, index) => ({
                    mapId: pyramid.mapId,
                    styleId: pyramid.styleId,
                    expected: pyramid.total,
                    present: tileStats[index].downloaded + tileStats[index].skipped,
                    bytes: tileStats[index].bytes
                }))
            },
            null,
            2
        ) + '\n'
    );

    console.log(`Report: ${relativeToRoot(REPORT_PATH)}`);
    console.log('');

    process.exitCode = totals.failed.length || totals.corrupt.length
        ? 1
        : 0;
}

main().catch(error => {
    console.error('');
    console.error('Offline mirror failed:', error.message);
    console.error('');
    process.exitCode = 1;
});
