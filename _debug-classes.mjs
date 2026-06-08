// Check which SKIP_CLASS_PATTERNS match HBR's h3
const SKIP_CLASS_PATTERNS = [
  'sidebar', 'side-bar', 'sideBar',
  'nav-menu', 'main-menu', 'navigation-menu', 'mobile-nav',
  'channels-nav', 'topics-nav', 'nav-topics',
  'footer-wrap', 'post-footer', 'site-footer', 'footer', 'footnote', 'copyright',
  'content-column-post-footer', 'content-column-mobile-footer',
  'subscribe-widget', 'widget-area', 'subscribe-',
  'ad-container', 'ad-slot', 'ads-box', 'advertisement',
  'adsbygoogle', 'google-ad', 'google-ads',
  'dfp-ad', 'dfp-unit', 'gpt-ad', 'div-gpt-ad',
  'ad-wrapper', 'ad-panel', 'ad-frame', 'ad-box', 'ad-inner', 'ad-holder',
  'ad-banner', 'ad-placeholder', 'ad-label', 'ad-unit', 'ad-widget', 'ad-area',
  'ad-div', 'ad-code', 'ad-block', 'ad-content', 'ad-outer',
  'adslot', 'adunit', 'adbox', 'advert', 'advertorial', 'adv',
  'display-ad', 'display-ads', 'header-ad', 'footer-ad', 'sticky-ad',
  'in-article-ad', 'inline-ad', 'incontent-ad', 'incontent-ads',
  'ezoic-ad', 'ezoic-pub', 'freestar-ad',
  'leaderboard', 'skyscraper',
  'taboola', 'taboola-widget', 'trc',
  'outbrain', 'outbrain-widget', 'ob-widget',
  'mgid', 'mgbox', 'marketgid',
  'revcontent', 'rev-content',
  'zergnet', 'zergnet-widget',
  'rc-widget',
  'native-ad', 'nativead', 'native-ads',
  'content-recommendation', 'recommended-content',
  'sponsored', 'sponsored-content', 'sponsored-post', 'sponsored-link', 'sponsored-links',
  'promoted', 'promoted-content', 'promoted-post',
  'paid-content', 'paid-post',
  'affiliate', 'affiliate-link',
  'commercial', 'commercial-content',
  'cookie-consent', 'cookie-banner', 'cookie-notice', 'cookie-policy', 'cookie-table', 'cookie-settings',
  'cookie-bar', 'cookie-box', 'cookie-modal', 'cookie-container', 'cookie-popup', 'cookie-overlay', 'cookie-wrapper',
  'cookie-law', 'cookie-disclaimer', 'cookie-management', 'cookie-accept', 'cookie-compliance', 'cookie-control',
  'cookies-modal', 'cookies-wrapper', 'cookie__wrap', 'coockies',
  'modal-cookie', 'modal-cookies', 'cookie-div',
  'cc-window', 'cc-banner', 'cc-overlay', 'cc-container', 'cc-floating',
  'cmpbox', 'cmpwrapper', 'cmp',
  'klaro',
  'onetrust-banner', 'onetrust-pc', 'onetrust-overlay',
  'ot-sdk', 'ot-pc', 'onetrust', 'ot-cookie', 'ot-policy', 'ot-category', 'ot-floating',
  'borlabs-cookie', 'brlbs',
  'cmplz', 'cmplz-cookie', 'cmplz-manage',
  'moove-gdpr',
  'cli-modal', 'cli-popup', 'cli-bar', 'wt-cli',
  'cky-consent', 'cky-notice', 'cky-modal', 'cky-banner',
  'wpfront-notification-bar',
  'gdpr', 'gdpr-banner', 'gdpr-consent', 'gdpr-modal', 'gdpr-overlay', 'gdpr-mask',
  'privacy', 'privacy-policy', 'privacy-notice', 'privacy-pref', 'privacy-popup', 'privacy-modal', 'privacy-info',
  'data-protection', 'data-privacy', 'data-consent',
  'consent', 'consent-banner', 'consent-container', 'consent-modal', 'consent-overlay',
  'consent-popup', 'consent-wrapper', 'outer-consent',
  'opt-in', 'optin',
  'eucookie', 'euc', 'cnil', 'ccpa', 'lgpd', 'rodo',
  'hinweis', 'confidentialite',
  'disclaimer', 'disclamer', 'disclaimer-container',
  'cookieman', 'cookiemgmt', 'cookie-management',
  'cbar', 'cono', 'coo', 'cook',
  'lawdiv', 'cookie-law-info',
  'banner-ad',
  'popup-overlay', 'modal-dialog', 'modal-backdrop',
  'social-share', 'share-buttons',
  'breadcrumb', 'byline', 'post-meta', 'author-box',
  'trending-stories', 'tns-trending-stories-block', 'related-posts',
  'related-articles', 'related-content', 'more-stories', 'more-articles',
  'also-read', 'you-may-like', 'read-next',
  'comment-list', 'comment-section', 'comment-area', 'comment-module',
  'comment-wrapper', 'comment-body', 'comment-content', 'comment-form',
  'comment-reply', 'comment-thread', 'comment-holder', 'comment-entry',
  'comments-area', 'comments-section', 'comments-wrapper',
  'commentlist', 'discussion',
  'search-form', 'search-box', 'search-bar', 'searchbar', 'search-input',
  'search-wrapper', 'search-widget', 'search-container', 'search-results',
  'login-form', 'login-box', 'login-bar', 'loginbar',
  'signin-form', 'signup-form', 'register-form', 'registration',
  'auth-form', 'auth-box', 'user-area', 'user-menu', 'user-profile',
  'member-area', 'membership',
  'newsletter-signup', 'newsletter-form', 'newsletter-subscribe',
  'newsletter-popup', 'newsletter-overlay', 'newsletter-modal',
  'email-signup', 'email-subscribe', 'email-capture', 'signup-form',
  'pagination', 'pager', 'paging', 'page-nav', 'page-numbers',
  'nav-links', 'post-navigation',
  'toc', 'table-of-contents', 'toc-container', 'toc-widget',
  'lang-switcher', 'language-switcher', 'language-selector',
  'lang-select', 'lang-selector', 'locale-switcher', 'locale-selector',
  'tagcloud', 'tags-list', 'tag-list', 'categories-list', 'category-list',
  'taxonomy-list', 'meta-tags', 'entry-tags',
  'captcha', 'g-recaptcha', 'recaptcha', 'h-captcha', 'hcaptcha', 'turnstile',
  'post-date', 'entry-date', 'entry-time', 'published-date', 'published-time',
  'posted-on', 'updated-on',
  'print-only', 'print-version', 'printable',
  'site-header', 'site-top', 'top-bar', 'topbar', 'masthead',
  'site-branding', 'site-logo', 'header-top', 'header-main',
  'rating-widget', 'rating-box', 'rating-container', 'star-rating', 'user-rating',
  'review-widget', 'review-box', 'review-form', 'reviews-widget', 'reviews-list',
  'poll', 'voting', 'vote-widget', 'survey',
  'exit-popup', 'exit-intent', 'welcome-popup', 'welcome-mat',
  'notranslate'
];

const className = 'Subheader-module-scss-module__ZOTTua__subheader Subheader-module-scss-module__ZOTTua__h3 undefined';
const classList = className.toLowerCase().split(/\s+/);

const matches = [];
for (const pattern of SKIP_CLASS_PATTERNS) {
  for (const cls of classList) {
    if (cls === pattern ||
        cls.startsWith(pattern + '-') ||
        cls.startsWith(pattern + '_') ||
        cls.endsWith('-' + pattern) ||
        cls.endsWith('_' + pattern)) {
      matches.push({ pattern, cls });
    }
  }
}
console.log('Matched patterns:');
for (const m of matches) {
  console.log(`  pattern "${m.pattern}" matched token "${m.cls}"`);
}
if (matches.length === 0) {
  console.log('  (none)');
}
console.log('\nFull classList:');
for (const c of classList) {
  console.log(`  "${c}"`);
}
