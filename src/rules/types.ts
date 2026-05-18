export interface SiteRule {
  /**
   * Host pattern to match, e.g. 'github.com', '*.example.com'
   * Supports exact match and wildcard prefix
   */
  hostPattern: string;

  /**
   * Terms that should NOT be translated, kept as-is
   */
  skipTerms?: string[];

  /**
   * CSS selectors whose content should be skipped entirely
   */
  skipSelectors?: string[];

  /**
   * Additional prompt instructions for this site
   */
  promptInstructions?: string;
}

export interface MatchedRule {
  siteRule: SiteRule;
  matchedPattern: string;
}
