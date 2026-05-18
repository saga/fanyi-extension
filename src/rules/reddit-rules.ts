import type { SiteRule } from './types';

export const redditRule: SiteRule = {
  hostPattern: 'reddit.com',
  skipTerms: [
    'Home',
    'Hot',
    'New',
    'Top',
    'Rising',
    'Reddit',
    'Subreddit',
    'Upvote',
    'Downvote',
    'Karma',
    'Award',
    'Share',
    'Save',
    'Report',
    'Crosspost',
    'Moderator',
    'Admin',
    'Post',
    'Comment',
    'Sort by',
    'Best',
    'Controversial',
  ],
  skipSelectors: [
    'shreddit-comment',
    'faceplate-blot',
    '[data-click-id="score"]',
  ],
  promptInstructions:
    'This is a Reddit page. Keep community-specific terms, subreddit names, UI labels like "upvote/downvote/karma", and usernames untranslated.',
};
