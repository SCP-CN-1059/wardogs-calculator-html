let WEAPONS = {};
let APP_CONFIG = {};
// The optional lobby runtime is never loaded when collaboration is disabled.
let lobby = null;

const S = {
    w: 16,
    h: 16,

    zoom: 1,

    mode: 'origin',

    map: 'bakurani',

    mapStyle: 'grayscale',

    weapon: null,

    origin: {
        x: 5,
        y: 5
    },

    target: {
        x: 5.5,
        y: 5.5
    },

    panX: 0,
    panY: 0
};

let LANG = 'en';
let DEFAULT_LANG = 'en';

let LANGUAGES = [];
let I18N = {};
let MAPS = {};
let MAP_ASSETS = {};

let drag = null;
let pan = null;


/* =========================
   FEATURE SWITCHES
   ========================= */

/*
 * The standalone build (scripts/build-single-file.mjs) ships a reduced
 * calculator: one language, one map style, no accessibility panel, no drawing
 * tools, no import/export and no message of the day. It sets
 * window.__WARDOGS_FEATURES__ before any application script runs.
 *
 * Every switch defaults to on and is only skipped when it is explicitly set to
 * false, so the hosted site and the offline mirror keep their full interface.
 */
const APP_FEATURES = {
    locales: true,
    mapStyle: true,
    accessibility: true,
    drawingTools: true,
    dataTransfer: true,
    motd: true,

    ...(
        typeof window !== 'undefined' &&
        window.__WARDOGS_FEATURES__ &&
        typeof window.__WARDOGS_FEATURES__ === 'object'
            ? window.__WARDOGS_FEATURES__
            : {}
    )
};

function featureEnabled(name) {

    return APP_FEATURES[name] !== false;
}

/*
 * Set by the same build when only one language is embedded: the interface is
 * then locked to it instead of following the browser language.
 */
const APP_LANGUAGE =
    typeof window !== 'undefined' &&
    typeof window.__WARDOGS_LANGUAGE__ === 'string' &&
    window.__WARDOGS_LANGUAGE__
        ? window.__WARDOGS_LANGUAGE__
        : '';

let savedTargets = [];

const SAVED_TARGETS_KEY =
    'wardogs-saved-targets';

const SAVE_ARTILLERY_KEY =
    'wardogs-save-artillery-position';

const MAP_POINTS_KEY =
    'wardogs-map-points';

const APP_SELECTIONS_KEY =
    'wardogs-app-selections';

const MAP_STYLE_STORAGE_KEY =
    'wardogs-map-style';

const DEFAULT_CUSTOM_MAP_SIZE = {
    w: 10,
    h: 10
};

let savedCustomMapSize = {
    ...DEFAULT_CUSTOM_MAP_SIZE
};


/* =========================
   PERSISTED APP SELECTIONS
   ========================= */

function loadAppSelections() {
    loadMapStylePreference();

    try {
        const raw =
            localStorage.getItem(
                APP_SELECTIONS_KEY
            );

        if (!raw) {
            return;
        }

        const parsed =
            JSON.parse(raw);

        if (
            typeof parsed?.map ===
                'string' &&
            parsed.map.trim()
        ) {
            S.map =
                parsed.map.trim();
        }

        if (
            typeof parsed?.weapon ===
                'string' &&
            parsed.weapon.trim()
        ) {
            S.weapon =
                parsed.weapon.trim();
        }

        const customWidth =
            Number(parsed?.customMap?.w);

        const customHeight =
            Number(parsed?.customMap?.h);

        if (
            Number.isFinite(customWidth) &&
            Number.isFinite(customHeight) &&
            customWidth >= 1 &&
            customWidth <= 100 &&
            customHeight >= 1 &&
            customHeight <= 100
        ) {
            savedCustomMapSize = {
                w: customWidth,
                h: customHeight
            };
        }

        if (S.map === 'custom') {
            S.w = savedCustomMapSize.w;
            S.h = savedCustomMapSize.h;
        }
    } catch (error) {
        console.warn(
            'Failed to load app selections:',
            error
        );
    }
}

function persistAppSelections() {
    if (lobby?.active) { lobby.capture(); return; }
    try {
        if (S.map === 'custom') {
            savedCustomMapSize = {
                w: S.w,
                h: S.h
            };
        }

        localStorage.setItem(
            APP_SELECTIONS_KEY,
            JSON.stringify({
                map: S.map,
                weapon: S.weapon,
                customMap: {
                    ...savedCustomMapSize
                }
            })
        );
    } catch (error) {
        console.warn(
            'Failed to save app selections:',
            error
        );
    }
}

function getSavedCustomMapSize() {
    return {
        ...savedCustomMapSize
    };
}



/* =========================
   MAP STYLE PREFERENCE
   ========================= */

function loadMapStylePreference() {
    try {
        const saved =
            localStorage.getItem(
                MAP_STYLE_STORAGE_KEY
            );

        if (
            typeof saved === 'string' &&
            saved.trim()
        ) {
            S.mapStyle =
                saved.trim();
        }
    } catch (error) {
        console.warn(
            'Failed to load map style preference:',
            error
        );
    }
}

function persistMapStylePreference() {
    try {
        localStorage.setItem(
            MAP_STYLE_STORAGE_KEY,
            S.mapStyle
        );
    } catch (error) {
        console.warn(
            'Failed to save map style preference:',
            error
        );
    }
}

/* =========================
   KEYBOARD SHORTCUTS
   ========================= */

/*
 * event.key follows the active keyboard layout (KeyR becomes "к" on a
 * Russian layout). Shortcut bindings describe physical keys, so prefer
 * event.code for letters/digits and fall back to event.key for everything
 * else. This keeps shortcuts layout-independent without changing displayed
 * shortcut labels.
 */
function getKeyboardShortcutKey(event) {
    const code =
        String(event?.code || '');

    if (/^Key[A-Z]$/.test(code)) {
        return code.slice(3).toLowerCase();
    }

    if (/^Digit[0-9]$/.test(code)) {
        return code.slice(5);
    }

    const codeKeys = {
        Escape: 'escape',
        ArrowUp: 'arrowup',
        ArrowRight: 'arrowright',
        ArrowDown: 'arrowdown',
        ArrowLeft: 'arrowleft',
        Equal: event?.shiftKey ? '+' : '=',
        NumpadAdd: '+',
        Minus: event?.shiftKey ? '_' : '-',
        NumpadSubtract: '-',
        Enter: 'enter',
        NumpadEnter: 'enter',
        Backspace: 'backspace',
        Delete: 'delete'
    };

    return (
        codeKeys[code] ||
        String(event?.key || '')
            .toLowerCase()
    );
}


/* =========================
   MAP POINT HIT TESTING
   ========================= */

function getNearestUnlockedMapPoint(
    originDistance,
    targetDistance,
    hitThreshold
) {
    const nearest = [
        {
            type: 'origin',
            distance: originDistance
        },
        {
            type: 'target',
            distance: targetDistance
        }
    ]
        .filter(
            point =>
                Number.isFinite(
                    point.distance
                ) &&
                !isPointMapLocked(
                    point.type
                )
        )
        .sort(
            (a, b) =>
                a.distance -
                b.distance
        )[0];

    return (
        nearest &&
        nearest.distance <= hitThreshold
    )
        ? nearest.type
        : null;
}


/* =========================
   ZOOM
   ========================= */

const MIN_ZOOM = 0.4;

const ZOOM_BUTTON_FACTOR = 1.25;
const ZOOM_WHEEL_IN = 1.15;
const ZOOM_WHEEL_OUT = 0.87;


/* =========================
   TILE DEFAULTS
   ========================= */

/*
 * These are only fallback values.
 *
 * Real map-specific values belong
 * inside the map JSON.
 */
const DEFAULT_TILE_SIZE = 256;
const DEFAULT_TILE_MIN_ZOOM = 0;
const DEFAULT_TILE_MAX_ZOOM = 5;
const DEFAULT_TILE_EXTENSION = 'webp';

const TILE_CACHE =
    new Map();

const MARKER_IMAGE_CACHE =
    new Map();


/* =========================
   DOM
   ========================= */

const $ = id =>
    document.getElementById(id);

/*
 * Writing the same string back still dirties layout, and the readouts are
 * rewritten on every pointer move while barely changing between frames.
 */
const setText = (el, value) => {
    if (el && el.textContent !== value) {
        el.textContent = value;
    }
};

const setStyle = (el, prop, value) => {
    if (el && el.style[prop] !== value) {
        el.style[prop] = value;
    }
};

const c =
    $('canvas');

const wrap =
    document.querySelector('.map');

const ctx =
    c.getContext('2d');

const BASE_PATH =
    new URL(
        '.',
        document.baseURI
    );
