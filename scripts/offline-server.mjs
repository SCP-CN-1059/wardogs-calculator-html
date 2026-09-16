/*
 * Offline launcher and static server for the WARDOGS calculator.
 *
 *     node scripts/offline-server.mjs              # serve and open the browser
 *     node scripts/offline-server.mjs --check      # report mirror status, serve nothing
 *     node scripts/offline-server.mjs --port 8100 --no-open
 *     node scripts/offline-server.mjs --log        # log every request path
 *
 * Why a server at all: the application fetches its map registry, locales and
 * terrain manifests with fetch(), and browsers refuse fetch() against file://
 * URLs. Serving the checkout over http://127.0.0.1 keeps every request on the
 * loopback interface, so nothing needs the internet once the mirror exists.
 *
 * Unlike scripts/dev-server.mjs this server does not watch files, does not
 * inject a live-reload client, and only exposes the paths the calculator
 * actually reads. It disables production analytics exactly like the dev
 * server does, because the page ships with the Umami tag.
 */

import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8000;

const OPTIONS = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    open: true,
    check: false,
    log: false
};

const PUBLIC_ROOT_FILES =
    new Set([
        '/style.css',
        '/mobile.css',
        '/robots.txt',
        '/favicon.ico',
        '/sitemap.xml'
    ]);

const PUBLIC_PREFIXES = [
    '/assets/',
    '/config/',
    '/data/',
    '/js/',
    '/locales/',
    '/maps/',
    '/styles/'
];

/*
 * The directories the calculator may read from. Requests are resolved segment
 * by segment and never through a joined relative path, so a percent-encoded
 * ".." or "%2f" cannot climb out of the public tree.
 */
const PUBLIC_DIRECTORIES =
    new Set(PUBLIC_PREFIXES.map(prefix => prefix.slice(1, -1)));

const HTML_ENTRY_POINTS = new Map([
    ['/', join(root, 'src', 'pages', 'index.html')],
    ['/index.html', join(root, 'src', 'pages', 'index.html')],
    ['/mobile/', join(root, 'src', 'pages', 'mobile', 'index.html')],
    ['/mobile/index.html', join(root, 'src', 'pages', 'mobile', 'index.html')]
]);

const MIME_TYPES = {
    '.bin': 'application/octet-stream',
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.xml': 'application/xml; charset=utf-8'
};

/*
 * Immutable, content-addressed-ish payloads are cached by the browser; source
 * and data files are not, so an edited checkout is picked up on reload.
 */
const IMMUTABLE_EXTENSIONS =
    new Set(['.bin', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp', '.woff2']);

function parseArgs(argv) {
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--help' || arg === '-h') {
            console.log(
                [
                    'Usage: node scripts/offline-server.mjs [options]',
                    '',
                    '  --port <n>    Port to listen on (default: 8000)',
                    '  --host <ip>   Interface to bind (default: 127.0.0.1)',
                    '  --no-open     Do not open a browser window',
                    '  --check       Print mirror status and exit',
                    '  --log         Log every request path'
                ].join('\n')
            );

            process.exit(0);
        }

        if (arg === '--no-open') {
            OPTIONS.open = false;
            continue;
        }

        if (arg === '--check') {
            OPTIONS.check = true;
            OPTIONS.open = false;
            continue;
        }

        if (arg === '--log') {
            OPTIONS.log = true;
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

        if (flag === '--port') {
            OPTIONS.port = Math.max(1, Math.min(65535, Number(value) || DEFAULT_PORT));
            continue;
        }

        if (flag === '--host') {
            OPTIONS.host = String(value);
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }
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

async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

/*
 * Counts files directly inside `path` and inside its immediate
 * subdirectories, which covers both layouts used by the mirror:
 *
 *   maps/tiles/<map>/zoom_0/0_0.webp    (one directory per zoom level)
 *   data/terrain/<map>/chunks/16_12.bin (flat directory)
 */
async function directorySummary(path) {
    const summary = {
        files: 0,
        bytes: 0
    };

    let entries = [];

    try {
        entries = await readdir(path, { withFileTypes: true });
    } catch {
        return summary;
    }

    const addFile = async filePath => {
        summary.files += 1;

        try {
            summary.bytes += (await stat(filePath)).size;
        } catch {
            // A file that vanished between readdir and stat is not interesting.
        }
    };

    for (const entry of entries) {
        if (entry.isFile()) {
            await addFile(join(path, entry.name));
            continue;
        }

        if (!entry.isDirectory()) {
            continue;
        }

        let children = [];

        try {
            children = await readdir(join(path, entry.name), { withFileTypes: true });
        } catch {
            continue;
        }

        for (const child of children) {
            if (child.isFile()) {
                await addFile(join(path, entry.name, child.name));
            }
        }
    }

    return summary;
}

/*
 * Reports what the offline mirror actually contains, so a partially downloaded
 * or half-mirrored checkout is obvious before the browser opens.
 */
async function describeMirror() {
    const index = await readJson(join(root, 'maps', 'index.json'));

    const files = Array.isArray(index)
        ? index
        : Array.isArray(index.maps)
            ? index.maps
            : [];

    const rows = [];
    let complete = true;

    for (const entry of files) {
        const file = typeof entry === 'string' ? entry : entry.file;

        if (!file) {
            continue;
        }

        const map = await readJson(join(root, 'maps', file));

        const styleEntries = Object.entries(map.tiles?.styles || {});

        for (const [styleId, style] of (styleEntries.length ? styleEntries : [['default', map.tiles]])) {
            /*
             * A style may only override `path`; zoom range, tile size and
             * extension still come from the map-level tile block, exactly as
             * getTileConfig() merges them for the renderer.
             */
            const tileConfig = { ...map.tiles, ...style };
            const path = String(tileConfig?.path || '');
            const match = path.match(/\/releases\/[^/]+\/(.+)$/);

            if (!match) {
                continue;
            }

            const localDirectory = resolve(root, match[1].split('/').join(sep));
            const summary = await directorySummary(localDirectory);

            const expected = (() => {
                const minZoom = Number.isFinite(Number(tileConfig.minZoom)) ? Number(tileConfig.minZoom) : 0;
                const maxZoom = Number.isFinite(Number(tileConfig.maxZoom)) ? Number(tileConfig.maxZoom) : 5;

                let total = 0;

                for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
                    total += Math.pow(2, zoom) ** 2;
                }

                return total;
            })();

            const ok = summary.files >= expected;

            if (!ok) {
                complete = false;
            }

            rows.push({
                label: `tiles ${map.id}/${styleId}`,
                ok,
                detail: `${summary.files}/${expected} tiles · ${formatBytes(summary.bytes)}`
            });
        }
    }

    const terrainContext = await readJson(
        join(root, 'data', 'ballistics', 'terrain-context.json')
    );

    for (const mapId of Object.keys(terrainContext.terrainMaps || {})) {
        const chunks = await directorySummary(join(root, 'data', 'terrain', mapId, 'chunks'));
        const manifestPresent = await stat(join(root, 'data', 'terrain', mapId, 'manifest.json'))
            .then(() => true)
            .catch(() => false);

        const ok = manifestPresent && chunks.files > 0;

        if (!ok) {
            complete = false;
        }

        rows.push({
            label: `terrain ${mapId}`,
            ok,
            detail: `${manifestPresent ? 'manifest' : 'NO manifest'} · ${chunks.files} chunks · ${formatBytes(chunks.bytes)}`
        });
    }

    return { rows, complete };
}

async function printMirrorStatus() {
    const { rows, complete } = await describeMirror();

    console.log('Offline mirror:');

    for (const row of rows) {
        console.log(`  ${row.ok ? 'OK  ' : 'MISS'} ${row.label.padEnd(26)} ${row.detail}`);
    }

    if (!complete) {
        console.log('');
        console.log('  Some assets are missing. Mirror them with:');
        console.log('    node scripts/fetch-map-tiles.mjs --terrain');
    }

    console.log('');

    return complete;
}

function prepareHTML(html) {
    return html
        .replace(
            /\s*<script[^>]*src=["']https:\/\/cloud\.umami\.is\/script\.js["'][^>]*><\/script>/gi,
            ''
        )
        .replace(
            '<head>',
            '<head>\n<script>window.__WARDOGS_ANALYTICS_DISABLED__ = true;</script>'
        );
}

function sendText(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
    response.writeHead(statusCode, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
    });

    response.end(body);
}

function hostAllowed(request) {
    const header = request.headers.host;

    if (!header) {
        return true;
    }

    const hostname = header.startsWith('[')
        ? header.slice(1, header.indexOf(']'))
        : header.split(':')[0];

    return ['127.0.0.1', 'localhost', '::1', OPTIONS.host].includes(hostname.toLowerCase());
}

/*
 * Maps a request path to a file inside the public tree, or null when the path
 * is not published. Every segment is checked, so no request can escape.
 */
function resolvePublicFile(pathname) {
    if (PUBLIC_ROOT_FILES.has(pathname)) {
        return join(root, pathname.slice(1));
    }

    if (!PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix))) {
        return null;
    }

    const segments = pathname
        .split('/')
        .filter(Boolean);

    if (
        !segments.length ||
        segments.some(segment => segment === '.' || segment === '..' || segment.includes('\\'))
    ) {
        return null;
    }

    const [directory, ...rest] = segments;

    if (!PUBLIC_DIRECTORIES.has(directory)) {
        return null;
    }

    return join(root, directory, ...rest);
}

function sendFile(response, filePath, pathname) {
    const extension = extname(filePath).toLowerCase();
    const cacheable = IMMUTABLE_EXTENSIONS.has(extension);

    response.writeHead(200, {
        'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
        'Cache-Control': cacheable
            ? 'public, max-age=604800'
            : 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
    });

    if (OPTIONS.log) {
        console.log(`200 ${pathname}`);
    }

    createReadStream(filePath)
        .on('error', () => response.destroy())
        .pipe(response);
}

async function handleRequest(request, response) {
    if (!hostAllowed(request)) {
        sendText(response, 403, 'Forbidden host.');

        return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendText(response, 405, 'Method not allowed.');

        return;
    }

    let pathname = '';

    try {
        pathname = decodeURIComponent(
            new URL(request.url, 'http://localhost').pathname
        );
    } catch {
        sendText(response, 400, 'Bad request.');

        return;
    }

    if (pathname.includes('\0')) {
        sendText(response, 400, 'Bad request.');

        return;
    }

    /*
     * /maps/<id>/ is the published landing-page route. Offline there is no
     * generated page, so send the visitor straight into the calculator with
     * the map already selected.
     */
    const landingMatch = pathname.match(/^\/maps\/([a-z0-9-]+)\/?$/i);

    if (landingMatch) {
        response.writeHead(302, {
            Location: `/?map=${landingMatch[1].toLowerCase()}`,
            'Cache-Control': 'no-store, max-age=0'
        });

        response.end();

        return;
    }

    const htmlEntry = HTML_ENTRY_POINTS.get(pathname);

    if (htmlEntry) {
        try {
            const html = prepareHTML(await readFile(htmlEntry, 'utf8'));

            sendText(response, 200, html, 'text/html; charset=utf-8');

            if (OPTIONS.log) {
                console.log(`200 ${pathname} (page)`);
            }
        } catch (error) {
            sendText(response, 500, `Cannot read ${pathname}: ${error.message}`);
        }

        return;
    }

    const filePath = resolvePublicFile(pathname);

    if (!filePath) {
        sendText(response, 404, 'Not found.');

        return;
    }

    let info = null;

    try {
        info = await stat(filePath);
    } catch {
        info = null;
    }

    if (!info?.isFile()) {
        if (OPTIONS.log) {
            console.log(`404 ${pathname}`);
        }

        sendText(response, 404, 'Not found.');

        return;
    }

    if (request.method === 'HEAD') {
        response.writeHead(200, {
            'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Content-Length': info.size,
            'Cache-Control': 'no-store, max-age=0'
        });

        response.end();

        return;
    }

    sendFile(response, filePath, pathname);
}

function openBrowser(url) {
    const command = process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '', url] }
        : process.platform === 'darwin'
            ? { file: 'open', args: [url] }
            : { file: 'xdg-open', args: [url] };

    try {
        spawn(command.file, command.args, {
            detached: true,
            stdio: 'ignore'
        }).unref();
    } catch (error) {
        console.log(`Open ${url} in a browser (automatic launch failed: ${error.message}).`);
    }
}

async function main() {
    parseArgs(process.argv.slice(2));

    console.log('');
    console.log('WARDOGS offline calculator');
    console.log(`Checkout: ${root}`);
    console.log('');

    const complete = await printMirrorStatus();

    if (OPTIONS.check) {
        process.exitCode = complete ? 0 : 1;

        return;
    }

    const server = createServer((request, response) => {
        handleRequest(request, response).catch(error => {
            console.error(error);
            sendText(response, 500, 'Offline server error.');
        });
    });

    server.on('error', error => {
        if (error.code === 'EADDRINUSE') {
            console.error(
                `Port ${OPTIONS.port} is already in use. ` +
                'Close the other server or start this one with --port 8100.'
            );

            process.exit(1);
        }

        console.error(error.message);

        process.exit(1);
    });

    server.listen(OPTIONS.port, OPTIONS.host, () => {
        const url = `http://${OPTIONS.host}:${OPTIONS.port}/`;

        console.log(`Calculator: ${url}`);
        console.log(`Mobile:     ${url}mobile/`);
        console.log('');

        if (complete) {
            console.log('Everything is served from this machine — no internet needed.');
        } else {
            console.log('Running with an incomplete mirror: missing assets stay blank.');
        }

        console.log('Press Ctrl+C to stop.');
        console.log('');

        if (OPTIONS.open) {
            openBrowser(url);
        }
    });

    const shutdown = () => {
        server.close(() => process.exit(0));
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(error => {
    console.error('');
    console.error('Offline server failed:', error.message);
    console.error('');
    process.exitCode = 1;
});
