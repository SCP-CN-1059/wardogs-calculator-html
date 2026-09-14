/* =========================
   RESOURCES
   ========================= */

const STATIC_JSON_FETCH_ATTEMPTS = 2;
const STATIC_JSON_RETRY_DELAY = 500;

function resourceURL(path) {
    return new URL(
        path,
        BASE_PATH
    ).href;
}

function getStaticResourceVersion() {
    const script =
        document.querySelector(
            'script[src*="js/app.bundle.js"], ' +
            'script[src*="js/mobile.bundle.js"], ' +
            'script[src*="js/main.js"]'
        );

    if (!script?.src) {
        return '';
    }

    try {
        return (
            new URL(script.src)
                .searchParams
                .get('v') ||
            ''
        );
    } catch {
        return '';
    }
}

function versionStaticResource(url) {
    const version =
        getStaticResourceVersion();

    if (!version) {
        return {
            url,
            versioned: false
        };
    }

    try {
        const resolved =
            new URL(url);

        resolved.searchParams.set(
            'v',
            version
        );

        return {
            url: resolved.href,
            versioned: true
        };
    } catch {
        return {
            url,
            versioned: false
        };
    }
}

function classifyStaticJsonResource(path) {
    const normalized =
        String(path || '')
            .split(/[?#]/, 1)[0]
            .replace(/^\.\//, '')
            .toLowerCase();

    const fixed = {
        'config/app.json': 'app-config',
        'data/weapons.json': 'weapons',
        'locales/index.json': 'locales-index',
        'maps/index.json': 'maps-index',
        'maps/assets.json': 'map-assets'
    };

    if (fixed[normalized]) {
        return fixed[normalized];
    }

    const localeMatch =
        normalized.match(
            /^locales\/([^/]+)\.json$/
        );

    if (localeMatch) {
        return `locale-${localeMatch[1]}`
            .slice(0, 64);
    }

    const mapMatch =
        normalized.match(
            /^maps\/([^/]+)\.json$/
        );

    if (mapMatch) {
        return `map-${mapMatch[1]}`
            .slice(0, 64);
    }

    return 'static-json';
}

function isRetryableStaticJsonFailure(code) {
    if (code === 'network') {
        return true;
    }

    const match =
        String(code || '')
            .match(/^http-(\d{3})$/);

    if (!match) {
        return false;
    }

    const status =
        Number(match[1]);

    return (
        status === 408 ||
        status === 429 ||
        (
            status >= 500 &&
            status <= 599
        )
    );
}

function waitForStaticJsonRetry() {
    return new Promise(
        resolve =>
            window.setTimeout(
                resolve,
                STATIC_JSON_RETRY_DELAY
            )
    );
}

async function fetchJSON(path) {

    const resource =
        versionStaticResource(
            resourceURL(path)
        );

    const url =
        resource.url;

    const normalizedPath =
        String(path || '');

    const mapMatch =
        normalizedPath.match(
            /^maps\/([^/]+)\.json(?:[?#].*)?$/i
        );

    const isMapResource =
        normalizedPath.startsWith(
            'maps/'
        );

    const resourceId =
        classifyStaticJsonResource(
            normalizedPath
        );

    let lastError = null;
    let failureCode = 'network';

    for (
        let attempt = 1;
        attempt <= STATIC_JSON_FETCH_ATTEMPTS;
        attempt++
    ) {
        failureCode = 'network';

        try {
            const response =
                await fetch(
                    url,
                    {
                        /*
                         * Production JSON URLs carry the current build fingerprint,
                         * so cached data is invalidated automatically on deploy.
                         * Keep no-cache for local/dev builds with no fingerprint.
                         */
                        cache:
                            resource.versioned
                                ? 'force-cache'
                                : 'no-cache'
                    }
                );

            if (!response.ok) {
                failureCode =
                    `http-${response.status}`;

                throw new Error(
                    `Failed to load ${url}: ${response.status} ${response.statusText}`
                );
            }

            failureCode =
                'decode';

            return await response.json();

        } catch (error) {
            lastError = error;

            if (
                attempt < STATIC_JSON_FETCH_ATTEMPTS &&
                isRetryableStaticJsonFailure(
                    failureCode
                )
            ) {
                await waitForStaticJsonRetry();
                continue;
            }

            if (
                typeof trackOperationalFailure ===
                    'function'
            ) {
                const mapId =
                    mapMatch &&
                    ![
                        'index',
                        'assets'
                    ].includes(
                        mapMatch[1].toLowerCase()
                    )
                        ? mapMatch[1]
                        : '';

                trackOperationalFailure(
                    isMapResource
                        ? 'map-load-failed'
                        : 'asset-load-failed',
                    {
                        area:
                            isMapResource
                                ? 'maps'
                                : 'resources',
                        type: 'json',
                        map: mapId,
                        code: failureCode,
                        resource: resourceId,
                        attempts: attempt
                    }
                );
            }

            throw error;
        }
    }

    throw lastError;
}
