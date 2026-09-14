/* =========================
   POINT MAP LOCKS
   ========================= */

const POINT_MAP_LOCKS = {
    origin: false,
    target: false
};

function isPointMapLocked(type) {
    return Boolean(
        POINT_MAP_LOCKS[type]
    );
}

function setPointMapLocked(type, locked) {
    if (!(type in POINT_MAP_LOCKS)) {
        return;
    }

    POINT_MAP_LOCKS[type] =
        Boolean(locked);

    updatePointLocksUI();
    draw();
}

function togglePointMapLock(type) {
    setPointMapLocked(
        type,
        !isPointMapLocked(type)
    );
}

function updatePointLocksUI() {
    [
        ['origin', 'coordinateOriginLock', 'originMode'],
        ['target', 'coordinateTargetLock', 'targetMode']
    ].forEach(
        ([type, buttonId, modeId]) => {
            const locked =
                isPointMapLocked(type);

            const button = $(buttonId);
            const modeButton = $(modeId);

            if (button) {
                const actionLabel = tr(
                    locked
                        ? 'unlockPosition'
                        : 'lockPosition'
                );

                button.textContent = '';

                button.classList.toggle(
                    'active',
                    locked
                );

                button.setAttribute(
                    'aria-pressed',
                    locked
                        ? 'true'
                        : 'false'
                );

                button.setAttribute(
                    'aria-label',
                    actionLabel
                );

                button.title = tr(
                    locked
                        ? 'unlockPositionHint'
                        : 'lockPositionHint'
                );
            }

            modeButton?.classList.toggle(
                'point-map-locked',
                locked
            );
        }
    );
}
