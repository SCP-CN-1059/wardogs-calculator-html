/*
 * The offline mirror is only useful if the runtime rewrites published release
 * URLs to exactly the paths scripts/fetch-map-tiles.mjs writes. That contract
 * lives in js/core/resources.js, so these tests load the real file into a VM
 * context and call the real functions instead of re-implementing the regex.
 *
 * Assertions that need mirrored files are skipped when the pyramid is absent
 * (a plain checkout, or CI), so the suite still guards the URL contract.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');

async function loadResourcesModule({ offlineEnabled }) {
    const source = await readFile(
        join(root, 'js', 'core', 'resources.js'),
        'utf8'
    );

    const context = vm.createContext({
        APP_CONFIG: {
            offline: {
                enabled: offlineEnabled
            }
        },

        BASE_PATH: 'http://127.0.0.1:8000/',

        URL,
        console,

        document: {
            baseURI: 'http://127.0.0.1:8000/',
            querySelector: () => null
        },

        window: {}
    });

    vm.runInContext(source, context);

    return context;
}

async function registeredMaps() {
    const index = JSON.parse(
        await readFile(join(root, 'maps', 'index.json'), 'utf8')
    );

    const files = Array.isArray(index)
        ? index
        : Array.isArray(index.maps)
            ? index.maps
            : [];

    const maps = [];

    for (const entry of files) {
        const file = typeof entry === 'string' ? entry : entry.file;

        if (file) {
            maps.push(
                JSON.parse(await readFile(join(root, 'maps', file), 'utf8'))
            );
        }
    }

    return maps;
}

function pyramidStyles(map) {
    const styles = Object.entries(map.tiles?.styles || {});

    return styles.length
        ? styles
        : [['default', map.tiles]];
}

function checkoutPath(releasePath) {
    return join(root, ...releasePath.split('/'));
}

test('offline mode rewrites every published pyramid URL to a checkout path', async () => {
    const resources = await loadResourcesModule({ offlineEnabled: true });
    const maps = await registeredMaps();

    let checked = 0;

    for (const map of maps) {
        for (const [styleId, style] of pyramidStyles(map)) {
            const path = style?.path;

            assert.ok(
                typeof path === 'string' && path,
                `${map.id}/${styleId} has no tile path`
            );

            const rewritten = resources.offlineResourcePath(path);

            assert.ok(
                !/^https?:/i.test(rewritten),
                `${map.id}/${styleId} still points at the network: ${rewritten}`
            );

            assert.match(
                rewritten,
                /^maps\/tiles(-color)?\/[a-z0-9-]+$/i,
                `${map.id}/${styleId} rewritten to an unexpected path`
            );

            assert.equal(
                rewritten,
                path.replace(/^.*\/releases\/[^/]+\//, '').replace(/\/+$/, ''),
                `${map.id}/${styleId} lost its release-relative path`
            );

            checked += 1;
        }
    }

    assert.ok(checked >= 3, 'expected at least three registered pyramids');
});

test('offline mode rewrites terrain manifests and keeps relative paths local', async () => {
    const resources = await loadResourcesModule({ offlineEnabled: true });

    const context = JSON.parse(
        await readFile(
            join(root, 'data', 'ballistics', 'terrain-context.json'),
            'utf8'
        )
    );

    const definitions = Object.entries(context.terrainMaps || {});

    assert.ok(definitions.length, 'terrain context registers no maps');

    for (const [mapId, definition] of definitions) {
        assert.equal(
            resources.offlineResourcePath(definition.terrainManifest),
            `data/terrain/${mapId}/manifest.json`,
            `${mapId} manifest is not mapped to the mirrored path`
        );
    }

    assert.equal(
        resources.offlineResourcePath('data/ballistics/terrain-context.json'),
        'data/ballistics/terrain-context.json',
        'relative paths must pass through untouched'
    );
});

test('disabled offline mode keeps published URLs untouched', async () => {
    const resources = await loadResourcesModule({ offlineEnabled: false });
    const published =
        'https://assets.wardogs-artillery.com/releases/assets-v1/maps/tiles/bakurani';

    assert.equal(resources.isOfflineMode(), false);
    assert.equal(resources.offlineResourcePath(published), published);
});

test('the mirrored pyramids and terrain data match the published layout', async (t) => {
    const resources = await loadResourcesModule({ offlineEnabled: true });
    const maps = await registeredMaps();

    for (const map of maps) {
        for (const [styleId, style] of pyramidStyles(map)) {
            /*
             * A style only overrides `path`; the zoom range, extension and
             * tile size stay on the map-level tile block.
             */
            const tileConfig = { ...map.tiles, ...style };
            const relative = resources.offlineResourcePath(tileConfig.path);
            const directory = checkoutPath(relative);
            const label = `${map.id}/${styleId}`;

            if (!existsSync(directory)) {
                t.diagnostic(`${label}: no offline mirror at ${relative}`);
                continue;
            }

            const minZoom = Number.isFinite(Number(tileConfig.minZoom))
                ? Number(tileConfig.minZoom)
                : 0;
            const maxZoom = Number.isFinite(Number(tileConfig.maxZoom))
                ? Number(tileConfig.maxZoom)
                : 5;
            const extension = `.${String(tileConfig.extension || 'webp').replace(/^\./, '')}`;

            let present = 0;
            let expected = 0;

            for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
                const side = Math.pow(2, zoom);
                expected += side * side;

                const names = await readdir(
                    join(directory, `zoom_${zoom}`)
                ).catch(() => []);

                present += names.filter(name => name.endsWith(extension)).length;
            }

            assert.equal(
                present,
                expected,
                `${label}: mirrored pyramid is incomplete (${present}/${expected} levels)`
            );
        }
    }

    const context = JSON.parse(
        await readFile(
            join(root, 'data', 'ballistics', 'terrain-context.json'),
            'utf8'
        )
    );

    for (const [mapId, definition] of Object.entries(context.terrainMaps || {})) {
        const manifestFile = checkoutPath(
            resources.offlineResourcePath(definition.terrainManifest)
        );

        if (!existsSync(manifestFile)) {
            t.diagnostic(`terrain/${mapId}: manifest is not mirrored`);
            continue;
        }

        const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
        const chunks = Object.values(manifest.chunks || {});

        assert.ok(chunks.length, `terrain/${mapId}: manifest lists no chunks`);

        const missing = [];

        for (const chunk of chunks) {
            const chunkFile = join(
                dirname(manifestFile),
                ...String(chunk.file).split('/')
            );

            if (!existsSync(chunkFile)) {
                missing.push(chunk.file);
            }
        }

        assert.deepEqual(
            missing,
            [],
            `terrain/${mapId}: ${missing.length} chunk(s) missing from the mirror`
        );
    }
});

test('the color pyramid mirrors the same layout as the black & white one', async () => {
    const resources = await loadResourcesModule({ offlineEnabled: true });

    assert.equal(
        resources.offlineResourcePath(
            'https://assets.wardogs-artillery.com/releases/assets-v1/maps/tiles-color/bakurani'
        ),
        'maps/tiles-color/bakurani'
    );
});
