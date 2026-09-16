/* =========================
   EVENTS
   ========================= */

/* =========================
   MAP POINTER GUARD
   ========================= */

/*
 * The right button is a map gesture of its own now: it places the artillery
 * position. The browser must not run one at the same time — no context menu on
 * release, no text selection, no native drag.
 *
 * Two things make that reliable:
 *
 *   1. a document-level contextmenu guard, because the menu is raised for the
 *      element under the pointer when the button comes up, which after a drag
 *      is frequently *not* the canvas;
 *   2. pointer capture on the canvas, so the whole drag, including a release
 *      over the sidebar or outside the map, is delivered to the map.
 */

let mapPointerCapture = null;

/*
 * The compatibility contextmenu event arrives after the button came up, so the
 * drag state is already cleared by then. A short grace window keeps the menu
 * suppressed for a release that happened over the sidebar or off the canvas.
 */
let mapContextMenuGuardUntil = 0;

function holdContextMenuGuard() {

    mapContextMenuGuardUntil =
        Date.now() + 600;
}

function beginMapPointerCapture(element, pointerId) {

    endMapPointerCapture();

    document.body
        ?.classList
        .add('map-dragging');

    try {

        element.setPointerCapture(
            pointerId
        );

        mapPointerCapture = {
            element,
            pointerId
        };

    } catch (error) {

        /*
         * Capture is a convenience: without it the drag still works while the
         * pointer stays over the canvas.
         */
        mapPointerCapture = null;
    }
}

function endMapPointerCapture() {

    document.body
        ?.classList
        .remove('map-dragging');

    if (!mapPointerCapture) {
        return;
    }

    const {
        element,
        pointerId
    } = mapPointerCapture;

    mapPointerCapture = null;

    try {

        if (
            typeof element.hasPointerCapture ===
                'function' &&
            element.hasPointerCapture(pointerId)
        ) {
            element.releasePointerCapture(
                pointerId
            );
        }

    } catch (error) {
        // The capture may already be gone.
    }
}

/**
 * True while a map drag or pan is in progress, whichever button started it.
 */
function isMapPointerBusy() {

    return Boolean(
        mapPointerCapture ||
        pan ||
        drag ||
        Date.now() < mapContextMenuGuardUntil
    );
}

function bindThemeToggle() {

    const toggle =
        $('themeToggle');

    if (!toggle) {
        return;
    }

    toggle.addEventListener(
        'click',
        toggleTheme
    );
}

function setPointPlacementMode(mode) {
    if (mode !== 'origin' && mode !== 'target') {
        return false;
    }

    S.mode = mode;

    $('originMode')
        ?.classList.toggle(
            'active',
            mode === 'origin'
        );

    $('targetMode')
        ?.classList.toggle(
            'active',
            mode === 'target'
        );

    return true;
}

function swapArtilleryAndTargetPoints() {
    pushMapToolHistory();

    const oldOrigin =
        S.origin;

    S.origin =
        S.target;

    S.target =
        oldOrigin;

    inputs();
}

function isAppShortcutInputTarget(target) {
    if (!target || target === document.body) {
        return false;
    }

    if (target.isContentEditable) {
        return true;
    }

    return [
        'INPUT',
        'TEXTAREA',
        'SELECT'
    ].includes(
        String(target.tagName || '')
            .toUpperCase()
    );
}

function handleAppShortcut(event) {
    if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat
    ) {
        return false;
    }

    const key =
        typeof getKeyboardShortcutKey === 'function'
            ? getKeyboardShortcutKey(event)
            : String(event.key || '').toLowerCase();

    /*
     * Plain Tab is an application shortcut on desktop. Handle it before the
     * editable-control guard so focused buttons/selects do not steal it for
     * focus navigation. Shift+Tab keeps the browser's normal focus behavior.
     */
    if (
        key === 'tab' &&
        !event.shiftKey &&
        !document.body.classList.contains('mobile-app') &&
        typeof toggleSidebar === 'function'
    ) {
        toggleSidebar();
        return true;
    }

    if (
        isAppShortcutInputTarget(
            event.target
        )
    ) {
        return false;
    }

    if (key === 'q') {
        setPointPlacementMode(
            S.mode === 'origin'
                ? 'target'
                : 'origin'
        );
        return true;
    }

    if (key === 'y') {
        swapArtilleryAndTargetPoints();
        return true;
    }

    if (
        key === 't' &&
        !document.body.classList.contains('mobile-app') &&
        typeof toggleDesktopSavedTargetsCollapsed === 'function'
    ) {
        toggleDesktopSavedTargetsCollapsed();
        return true;
    }

    return false;
}

function bindEvents() {

    /*
     * Persisted SPH-2 sessions do not need Terrain3D before the user actually
     * interacts with the calculator. Pointer interaction is a cheap universal
     * trigger; requestTerrainBallisticsRuntime() is idempotent.
     */
    document.addEventListener(
        'pointerdown',
        () => {
            if (
                typeof requestTerrainBallisticsForCurrentState ===
                    'function'
            ) {
                requestTerrainBallisticsForCurrentState();
            }
        },
        { passive: true }
    );

    $('mapSelect').addEventListener(
        'change',
        () => {
            if (lobby?.active) { $('mapSelect').value = S.map; return; }

            const key =
                $('mapSelect').value;

            if (
                key !==
                'custom'
            ) {

                S.map =
                    key;

                S.w =
                    MAPS[key].w;

                S.h =
                    MAPS[key].h;

            } else {

                S.map =
                    'custom';

                const customSize =
                    getSavedCustomMapSize();

                S.w =
                    customSize.w;

                S.h =
                    customSize.h;
            }

            if (
                typeof loadMapPoints ===
                'function'
            ) {
                loadMapPoints();
            }

            persistAppSelections();

            clamp(
                S.origin
            );

            clamp(
                S.target
            );

            S.zoom =
                1;

            S.panX =
                0;

            S.panY =
                0;

            resetMapToolHistory();
            updatePresetLock();

            if (
                typeof requestTerrainBallisticsForCurrentState ===
                    'function'
            ) {
                requestTerrainBallisticsForCurrentState();
            }

            if (
                typeof trackAnalytics ===
                'function'
            ) {
                trackAnalytics(
                    'map-changed',
                    {
                        map: S.map
                    }
                );
            }

            inputs();
        }
    );
    $('mapStyleSelect')
        ?.addEventListener(
            'change',
            () => {
                const map =
                    MAPS[S.map];

                const style =
                    $('mapStyleSelect')
                        .value;

                if (
                    !map ||
                    !getAvailableMapTileStyleIds(
                        map
                    ).includes(style)
                ) {
                    syncMapStyleSelect();
                    return;
                }

                S.mapStyle =
                    style;

                persistMapStylePreference();

                if (
                    typeof trackAnalytics ===
                        'function'
                ) {
                    trackAnalytics(
                        'map-style-changed',
                        {
                            map: S.map,
                            style: S.mapStyle
                        }
                    );
                }

                draw();
            }
        );

    $('language')?.addEventListener(
        'change',
        () => {

            const language =
                $('language')?.value;

            if (!language) {
                return;
            }

            switchLanguage(
                language
            );
        }
    );

    $('weapon').addEventListener(
        'change',
        () => {

            S.weapon =
                $('weapon').value;

            persistAppSelections();

            if (
                typeof requestTerrainBallisticsForCurrentState ===
                    'function'
            ) {
                requestTerrainBallisticsForCurrentState();
            }

            if (
                typeof trackAnalytics ===
                'function'
            ) {
                trackAnalytics(
                    'weapon-changed',
                    {
                        weapon: S.weapon
                    }
                );
            }

            draw();
        }
    );

    $('apply').addEventListener(
        'click',
        () => {
            if (lobby?.active) return;

            S.map =
                'custom';

            S.w =
                Math.max(
                    1,
                    Math.min(
                        100,
                        Number(
                            $('w').value
                        ) ||
                        10
                    )
                );

            S.h =
                Math.max(
                    1,
                    Math.min(
                        100,
                        Number(
                            $('h').value
                        ) ||
                        10
                    )
                );

            persistAppSelections();

            clamp(
                S.origin
            );

            clamp(
                S.target
            );

            S.zoom =
                1;

            S.panX =
                0;

            S.panY =
                0;

            resetMapToolHistory();
            updatePresetLock();

            if (
                typeof trackAnalytics ===
                'function'
            ) {
                trackAnalytics(
                    'map-changed',
                    {
                        map: 'custom'
                    }
                );
            }

            inputs();
        }
    );

    $('originMode').addEventListener(
        'click',
        () => setPointPlacementMode('origin')
    );

    $('targetMode').addEventListener(
        'click',
        () => setPointPlacementMode('target')
    );

    ['ox', 'oy'].forEach(
        id => {

            $(id).addEventListener(
                'change',
                () =>
                    inputPoint(
                        'origin'
                    )
            );
        }
    );

    ['tx', 'ty'].forEach(
        id => {

            $(id).addEventListener(
                'change',
                () =>
                    inputPoint(
                        'target'
                    )
            );
        }
    );

    $('coordinateOriginCopy')
        ?.addEventListener(
            'click',
            () => copyPointCoordinates('origin')
        );

    $('coordinateOriginPaste')
        ?.addEventListener(
            'click',
            () => pastePointCoordinates('origin')
        );

    $('coordinateTargetCopy')
        ?.addEventListener(
            'click',
            () => copyPointCoordinates('target')
        );

    $('coordinateTargetPaste')
        ?.addEventListener(
            'click',
            () => pastePointCoordinates('target')
        );

    $('coordinateOriginLock')
        ?.addEventListener(
            'click',
            () => togglePointMapLock('origin')
        );

    $('coordinateTargetLock')
        ?.addEventListener(
            'click',
            () => togglePointMapLock('target')
        );

    $('zoomIn').addEventListener(
        'click',
        () => {

            S.zoom =
                Math.min(
                    getMaxCameraZoom(),
                    S.zoom *
                    ZOOM_BUTTON_FACTOR
                );

            draw();
        }
    );

    $('zoomOut').addEventListener(
        'click',
        () => {

            S.zoom =
                Math.max(
                    MIN_ZOOM,
                    S.zoom /
                    ZOOM_BUTTON_FACTOR
                );

            draw();
        }
    );

    $('fit').addEventListener(
        'click',
        () => {

            S.zoom =
                1;

            S.panX =
                0;

            S.panY =
                0;

            draw();
        }
    );

    $('swap').addEventListener(
        'click',
        swapArtilleryAndTargetPoints
    );

    $('clear').addEventListener(
        'click',
        () => {

            pushMapToolHistory();

            const bounds =
                getViewBounds();

            S.origin = {
                x:
                bounds.minX,

                y:
                bounds.minY
            };

            S.target = {
                x:
                bounds.minX,

                y:
                bounds.minY
            };

            inputs();

            renderSavedTargets();
        }
    );


    /* =========================
       SAVED TARGETS
       ========================= */

    $('saveTarget').addEventListener(
        'click',
        saveCurrentTarget
    );

    $('saveArtilleryPosition')
        .addEventListener(
            'change',
            saveArtilleryPreference
        );

    $('exportSavedTargets')
        ?.addEventListener(
            'click',
            exportAllSavedTargets
        );

    $('importSavedTargets')
        ?.addEventListener(
            'click',
            importSavedTargets
        );


    /* =========================
       CANVAS
       ========================= */

    /*
     * Pointer capture is taken on pointerdown rather than mousedown: only a
     * pointer event carries a pointerId, and the capture is what keeps a drag
     * alive — and the browser out of the way — after the pointer leaves the
     * canvas.
     */
    c.addEventListener(
        'pointerdown',
        event => {

            /*
             * Touch gestures belong to the mobile interface, which tracks every
             * finger itself; capturing one of them here would get in its way.
             */
            if (event.pointerType === 'touch') {
                return;
            }

            if (
                event.button !== 0 &&
                event.button !== 1 &&
                event.button !== 2
            ) {
                return;
            }

            beginMapPointerCapture(
                c,
                event.pointerId
            );
        }
    );

    ['pointerup', 'pointercancel'].forEach(
        type => {

            c.addEventListener(
                type,
                () => {

                    holdContextMenuGuard();

                    endMapPointerCapture();
                }
            );
        }
    );

    c.addEventListener(
        'mousedown',
        e => {

            e.preventDefault();

            const rect =
                c.getBoundingClientRect();

            const p =
                toWorld(
                    e.clientX -
                    rect.left,

                    e.clientY -
                    rect.top
                );

            /*
             * Mouse map:
             *   middle drag, or Space + left drag  -> move the camera
             *   right button                       -> move the artillery
             *   left button                        -> move the target
             *
             * The two points therefore do not depend on which mode is
             * selected, and the right button is no longer a pan gesture.
             */
            const spacePan =
                e.button === 0 &&
                typeof isSpacePanHeld ===
                    'function' &&
                isSpacePanHeld();

            if (
                e.button === 1 ||
                spacePan
            ) {

                pan = {
                    startX:
                    e.clientX,

                    startY:
                    e.clientY,

                    originX:
                    S.panX,

                    originY:
                    S.panY
                };

                $('cursorCoords')
                    .style.display =
                    'none';

                setPresetMarkerHover(
                    null
                );

                return;
            }

            if (
                handleMapToolMouseDown(
                    e,
                    p
                )
            ) {
                drag = null;
                return;
            }

            if (
                handlePresetMarkerTargetMouseDown(
                    e
                )
            ) {
                drag = null;

                updateCursor(
                    e
                );

                return;
            }

            /*
             * The mode follows the point that was just placed, so the sidebar
             * coordinate fields always edit what the mouse last touched.
             */
            const pointType =
                e.button === 2
                    ? 'origin'
                    : e.button === 0
                        ? 'target'
                        : null;

            if (!pointType) {
                drag = null;
                updateCursor(e);
                return;
            }

            if (
                isPointMapLocked(
                    pointType
                )
            ) {
                drag = null;
                updateCursor(e);
                return;
            }

            if (S.mode !== pointType) {

                S.mode = pointType;

                $('originMode')?.classList.toggle(
                    'active',
                    S.mode === 'origin'
                );

                $('targetMode')?.classList.toggle(
                    'active',
                    S.mode === 'target'
                );
            }

            drag = pointType;

            pushMapToolHistory();

            S[drag] = {
                x:
                p.x,

                y:
                p.y
            };

            clamp(
                S[drag]
            );

            inputs();

            updateCursor(
                e
            );
        }
    );

    window.addEventListener(
        'mousemove',
        e => {

            /*
             * Browsers and gesture add-ons sometimes claim a right-button drag
             * for themselves (mouse gestures, drag-to-scroll). Marking the
             * event as handled while the right button is down tells them the
             * page is using that gesture.
             */
            if (e.buttons & 2) {
                e.preventDefault();
            }

            if (pan) {

                S.panX =
                    pan.originX +
                    (
                        e.clientX -
                        pan.startX
                    );

                S.panY =
                    pan.originY +
                    (
                        e.clientY -
                        pan.startY
                    );

                draw();

                return;
            }

            /*
             * One rect for the whole event. Reading it back after the
             * cursor readout has been written forces a layout, and this
             * handler used to read it twice.
             */
            const rect =
                c.getBoundingClientRect();

            updateCursor(
                e,
                rect
            );

            const toolWorld =
                toWorld(
                    e.clientX -
                    rect.left,
                    e.clientY -
                    rect.top
                );

            if (
                handleMapToolMouseMove(
                    e,
                    toolWorld
                )
            ) {
                drag = null;
                return;
            }

            updatePresetMarkerHover(
                e
            );

            if (!drag) {
                return;
            }

            const world =
                toWorld(
                    e.clientX -
                    rect.left,

                    e.clientY -
                    rect.top
                );

            S[drag] =
                world;

            clamp(
                S[drag]
            );

            inputs();

            updateCursor(
                e,
                rect
            );
        }
    );

    /*
     * The canvas alone is not enough: the menu is raised for whatever element
     * is under the pointer when the right button comes up, and a right drag
     * regularly ends over the sidebar or the toolbar. The guard therefore sits
     * on the document and covers the whole map surface plus any drag that is
     * in flight or has just finished.
     */
    document.addEventListener(
        'contextmenu',
        event => {

            if (
                isMapPointerBusy() ||
                event.target
                    ?.closest?.('.map')
            ) {
                event.preventDefault();
                event.stopPropagation();
            }
        },
        true
    );

    c.addEventListener(
        'contextmenu',
        e => {

            e.preventDefault();
        }
    );

    c.addEventListener(
        'mouseleave',
        () => {

            setPresetMarkerHover(
                null
            );

            if (!pan) {

                $('cursorCoords')
                    .style.display =
                    'none';
            }
        }
    );

    window.addEventListener(
        'mouseup',
        () => {

            const placedPoint =
                drag;

            handleMapToolMouseUp();

            if (
                placedPoint &&
                typeof trackAnalytics ===
                'function'
            ) {
                trackAnalytics(
                    `${placedPoint}-placed`,
                    {
                        map: S.map
                    }
                );
            }

            drag =
                null;

            pan =
                null;

            holdContextMenuGuard();

            endMapPointerCapture();
        }
    );

    /*
     * A drag that ends outside the window, or a tab switch in the middle of
     * one, must not leave the map stuck in a dragging state.
     */
    window.addEventListener(
        'blur',
        () => {

            drag = null;
            pan = null;

            holdContextMenuGuard();

            endMapPointerCapture();
        }
    );

    c.addEventListener(
        'wheel',
        e => {

            e.preventDefault();

            const rect =
                c.getBoundingClientRect();

            const mouseX =
                e.clientX -
                rect.left;

            const mouseY =
                e.clientY -
                rect.top;

            const before =
                toWorld(
                    mouseX,
                    mouseY
                );

            S.zoom =
                Math.max(
                    MIN_ZOOM,
                    Math.min(
                        getMaxCameraZoom(),
                        S.zoom *
                        (
                            e.deltaY <
                            0
                                ? ZOOM_WHEEL_IN
                                : ZOOM_WHEEL_OUT
                        )
                    )
                );

            const after =
                toWorld(
                    mouseX,
                    mouseY
                );

            S.panX +=
                (
                    after.x -
                    before.x
                ) *
                view().scale;

            S.panY -=
                (
                    after.y -
                    before.y
                ) *
                view().scale;

            draw();
        },
        {
            passive:
                false
        }
    );

    const cameraKeysLoaded =
        typeof handleCameraKeyDown ===
        'function';

    window.addEventListener(
        'keydown',
        e => {
            if (handleAppShortcut(e)) {
                e.preventDefault();
                return;
            }

            if (handleMapToolShortcut(e)) {
                e.preventDefault();
                return;
            }

            if (
                cameraKeysLoaded &&
                handleCameraKeyDown(e)
            ) {
                e.preventDefault();
            }
        }
    );

    if (cameraKeysLoaded) {

        window.addEventListener(
            'keyup',
            handleCameraKeyUp
        );

        /*
         * Held keys would otherwise stick when the window
         * loses focus mid-pan.
         */
        window.addEventListener(
            'blur',
            stopCameraPan
        );
    }

    window.addEventListener(
        'resize',
        resize
    );
}
