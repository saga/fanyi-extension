export interface SiteRule {
  /**
   * Host pattern to match, e.g. 'github.com', '*.example.com'
   * Supports exact match and wildcard prefix
   */
  hostPattern: string;

  /**
   * Terms that should NOT be translated, kept as-is
   */
  documentTerms?: string[];

  /**
   * CSS selectors whose content should be skipped entirely
   */
  skipSelectors?: string[];

  /**
   * Regex patterns (as strings) whose text content should be skipped entirely.
   * Useful for filtering out site-specific noise like Sentry chunk preload
   * lists injected into the DOM by a particular site.
   */
  skipTextPatterns?: string[];

  /**
   * Additional prompt instructions for this site
   */
  promptInstructions?: string;
}

export interface MatchedRule {
  siteRule: SiteRule;
  matchedPattern: string;
}
