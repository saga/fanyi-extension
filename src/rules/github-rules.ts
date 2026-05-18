import type { SiteRule } from './types';

export const githubRule: SiteRule = {
  hostPattern: 'github.com',
  skipTerms: [
    'Releases',
    'Packages',
    'license',
    'MIT',
    'README',
    'Issues',
    'Pull requests',
    'Actions',
    'Projects',
    'Wiki',
    'Security',
    'Insights',
    'Code',
    'Commits',
    'Branches',
    'Tags',
    'Contributors',
    'Fork',
    'Star',
    'Watch',
    'Code of conduct',
    'Contributing',
    'Support',
    'Funding',
  ],
  skipSelectors: [
    '.octicon',
    '[data-view-component="true"].d-flex',
    'code',
    'pre',
  ],
  promptInstructions:
    'This is a GitHub page. Keep UI navigation terms, file extensions, and code-related vocabulary untranslated. Preserve brand names and technical terms.',
};
