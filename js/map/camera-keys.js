/* =========================
   KEYBOARD CAMERA
   ========================= */

/*
 * WASD / arrow keys pan the map, +/- zoom it.
 * Panning runs from a frame loop that only exists while a
 * key is held, so an idle map costs nothing.
 */
const CAMERA_PAN_KEYS = {
    w: 'up',
    a: 'left',
    s: 'down',
    d: 'right',
    arrowup: 'up',
    arrowleft: 'left',
    arrowdown: 'down',
    arrowright: 'right'
};

const CAMERA_ZOOM_IN_KEYS =
    new Set(['+', '=']);

const CAMERA_ZOOM_OUT_KEYS =
    new Set(['-', '_']);

const CAMERA_SPRINT_FACTOR = 2.5;

const HELD_PAN_KEYS =
    new Set();

/*
 * Holding Space turns a primary-button drag into a map drag, the way image
 * viewers and GIS tools do it. Without Space the canvas keeps placing the
 * artillery and target points, which stays the fastest way to use them.
 * The right mouse button has always panned as well.
 */
let cameraSpacePanHeld = false;

function isSpacePanHeld() {
    return cameraSpacePanHeld;
}

function setSpacePanHeld(held) {

    if (
        cameraSpacePanHeld === held
    ) {
        return;
    }

    cameraSpacePanHeld =
        held;

    document.body
        ?.classList
        .toggle(
            'space-pan',
            held
        );
}

function isPanDirectionHeld(direction) {

    for (const key of HELD_PAN_KEYS) {

        if (
            CAMERA_PAN_KEYS[key] ===
            direction
        ) {
            return true;
        }
    }

    return false;
}

let cameraSprintHeld = false;

let cameraPanFrame = null;

let cameraPanLastFrame = 0;

function isTypingTarget(target) {
    return Boolean(
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable
    );
}

function stepCameraPan(timestamp) {

    if (!HELD_PAN_KEYS.size) {
        cameraPanFrame = null;
        return;
    }

    /*
     * Clamp the delta so a backgrounded tab does not
     * resume with one enormous jump.
     */
    const delta =
        Math.min(
            0.05,
            (
                timestamp -
                cameraPanLastFrame
            ) /
            1000
        );

    cameraPanLastFrame =
        timestamp;

    let dx = 0;
    let dy = 0;

    if (isPanDirectionHeld('left')) dx += 1;
    if (isPanDirectionHeld('right')) dx -= 1;
    if (isPanDirectionHeld('up')) dy += 1;
    if (isPanDirectionHeld('down')) dy -= 1;

    if (dx || dy) {

        /*
         * Normalise so diagonals are not faster than
         * a straight line.
         */
        const length =
            Math.hypot(dx, dy);

        const speed =
            getCameraPanSpeed() *
            (
                cameraSprintHeld
                    ? CAMERA_SPRINT_FACTOR
                    : 1
            ) *
            delta;

        S.panX +=
            (dx / length) *
            speed;

        S.panY +=
            (dy / length) *
            speed;

        draw();
    }

    cameraPanFrame =
        requestAnimationFrame(
            stepCameraPan
        );
}

function startCameraPan() {

    if (cameraPanFrame !== null) {
        return;
    }

    cameraPanLastFrame =
        performance.now();

    cameraPanFrame =
        requestAnimationFrame(
            stepCameraPan
        );
}

function stopCameraPan() {

    if (cameraPanFrame !== null) {
        cancelAnimationFrame(
            cameraPanFrame
        );

        cameraPanFrame = null;
    }

    HELD_PAN_KEYS.clear();

    cameraSprintHeld = false;

    setSpacePanHeld(false);
}

function zoomCameraFromKey(zoomIn) {

    S.zoom =
        zoomIn
            ? Math.min(
                getMaxCameraZoom(),
                S.zoom *
                ZOOM_BUTTON_FACTOR
            )
            : Math.max(
                MIN_ZOOM,
                S.zoom /
                ZOOM_BUTTON_FACTOR
            );

    draw();
}

function handleCameraKeyDown(event) {

    if (
        isTypingTarget(event.target) ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
    ) {
        return false;
    }

    const key =
        getKeyboardShortcutKey(
            event
        );

    if (key === ' ') {

        setSpacePanHeld(
            true
        );

        return true;
    }

    cameraSprintHeld =
        event.shiftKey;

    if (CAMERA_PAN_KEYS[key]) {

        HELD_PAN_KEYS.add(key);

        startCameraPan();

        return true;
    }

    if (CAMERA_ZOOM_IN_KEYS.has(key)) {
        zoomCameraFromKey(true);
        return true;
    }

    if (CAMERA_ZOOM_OUT_KEYS.has(key)) {
        zoomCameraFromKey(false);
        return true;
    }

    return false;
}

function handleCameraKeyUp(event) {

    const key =
        getKeyboardShortcutKey(
            event
        );

    if (key === ' ') {

        setSpacePanHeld(
            false
        );

        return;
    }

    cameraSprintHeld =
        event.shiftKey;

    HELD_PAN_KEYS.delete(key);
}
