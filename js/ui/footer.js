/* =========================
   FOOTER
   ========================= */

/*
 * The footer carries exactly one link: the project's own repository. Partner
 * and donation links used to live here as well; they were removed, and the
 * link below is the single remaining entry point.
 */
const PROJECT_REPOSITORY_URL =
    'https://github.com/apollyon-sys/wardogs-calculator';

function projectRepositoryUrl() {

    return String(
        APP_CONFIG
            ?.site
            ?.footer
            ?.repositoryUrl ||
        PROJECT_REPOSITORY_URL
    );
}

function createRepositoryLink(placement) {

    const link =
        document.createElement('a');

    link.className =
        'footer-repository-link';

    link.href =
        projectRepositoryUrl();

    link.target =
        '_blank';

    link.rel =
        'noopener noreferrer';

    link.textContent =
        'GitHub';

    link.addEventListener(
        'click',
        () => {

            if (
                typeof trackAnalytics ===
                'function'
            ) {
                trackAnalytics(
                    'repository-click',
                    {
                        placement
                    }
                );
            }
        }
    );

    return link;
}

const FEEDBACK_LAUNCHER_LABELS = {
    en: 'Feedback',
    ru: 'Обратная связь',
    uk: 'Зворотний зв’язок',
    de: 'Feedback',
    fr: 'Feedback',
    es: 'Comentarios',
    pl: 'Opinie',
    pt: 'Feedback',
    'zh-cn': '反馈',
    ko: '피드백',
    ja: 'フィードバック',
    cat: 'Meowback'
};

let feedbackRuntimePromise = null;

function feedbackFeatureEnabled() {
    return APP_CONFIG?.feedback?.enabled === true &&
        Boolean(String(APP_CONFIG?.feedback?.serverUrl || '').trim());
}

function feedbackLauncherLabel() {
    return FEEDBACK_LAUNCHER_LABELS[
        typeof LANG === 'string' ? LANG : 'en'
    ] || FEEDBACK_LAUNCHER_LABELS.en;
}

function loadFeedbackRuntime() {
    if (typeof openFeedbackDialog === 'function') {
        return Promise.resolve();
    }

    if (feedbackRuntimePromise) {
        return feedbackRuntimePromise;
    }

    feedbackRuntimePromise = new Promise((resolve, reject) => {
        const existing = document.querySelector(
            'script[data-feedback-runtime]'
        );

        if (existing) {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener(
                'error',
                () => reject(new Error('feedback-runtime')),
                { once: true }
            );
            return;
        }

        const script = document.createElement('script');
        const runtimeUrl = new URL(
            'js/ui/feedback.js',
            typeof BASE_PATH !== 'undefined'
                ? BASE_PATH
                : document.baseURI
        ).href;

        script.src = typeof versionRuntimeAsset === 'function'
            ? versionRuntimeAsset(runtimeUrl)
            : runtimeUrl;
        script.dataset.feedbackRuntime = '1';
        script.onload = resolve;
        script.onerror = () => reject(new Error('feedback-runtime'));
        document.head.appendChild(script);
    }).catch(error => {
        feedbackRuntimePromise = null;
        document.querySelector('script[data-feedback-runtime]')?.remove();
        throw error;
    });

    return feedbackRuntimePromise;
}

function createFeedbackLauncher() {
    const button = document.createElement('button');
    const label = feedbackLauncherLabel();

    button.type = 'button';
    button.className = 'footer-feedback-button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = `
        <span class="footer-feedback-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 5h14v10H9l-4 4V5Z"></path>
                <path d="M8 9h8"></path>
                <path d="M8 12h5"></path>
            </svg>
        </span>
        <span class="footer-feedback-label"></span>
    `;

    button.querySelector('.footer-feedback-label').textContent = label;

    button.addEventListener('click', async () => {
        if (button.disabled) return;

        button.disabled = true;

        try {
            await loadFeedbackRuntime();

            if (typeof openFeedbackDialog !== 'function') {
                throw new Error('feedback-runtime');
            }

            if (typeof trackAnalytics === 'function') {
                trackAnalytics('feedback-opened', {});
            }

            openFeedbackDialog();
        } catch (error) {
            console.warn('Feedback form could not load:', error);
        } finally {
            button.disabled = false;
        }
    });

    return button;
}

function renderFooter() {
    const footer =
        $('siteFooter') ||
        document.querySelector('footer');

    if (!footer) {
        return;
    }

    const config =
        APP_CONFIG
            ?.site
            ?.footer || {};

    footer.innerHTML = '';

    const disclaimer =
        document.createElement(
            'span'
        );

    disclaimer.className =
        'footer-disclaimer';

    disclaimer.textContent =
        typeof tr === 'function'
            ? tr('footerDisclaimer')
            : (config.disclaimer || '');

    const meta =
        document.createElement(
            'span'
        );

    meta.className =
        'footer-meta';

    if (feedbackFeatureEnabled()) {
        meta.appendChild(
            createFeedbackLauncher()
        );
    }

    const author =
        document.createElement(
            'span'
        );

    author.className =
        'footer-author';

    const productName =
        String(
            config.productName ||
            'WARDOGS Artillery Calculator'
        );

    const authorLabel =
        String(
            typeof tr === 'function'
                ? tr('authorLabel')
                : (config.authorLabel || 'by')
        );

    author.append(
        document.createTextNode(
            `${productName} ${authorLabel} `
        )
    );

    const authorName =
        document.createElement(
            'strong'
        );

    authorName.textContent =
        config.authorName ||
        'Apollyon';

    author.appendChild(
        authorName
    );

    if (config.version) {
        const version =
            document.createElement(
                'span'
            );

        version.className =
            'footer-version';

        version.textContent =
            `(${config.version})`;

        author.appendChild(
            version
        );
    }

    /*
     * The single link of the footer: the project repository.
     */
    const separator =
        document.createElement(
            'span'
        );

    separator.className =
        'footer-separator';

    separator.textContent =
        '·';

    author.append(
        separator,
        createRepositoryLink('footer')
    );

    meta.appendChild(
        author
    );

    if (disclaimer.textContent) {
        footer.appendChild(
            disclaimer
        );
    }

    footer.appendChild(
        meta
    );
}
