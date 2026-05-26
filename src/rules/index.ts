import type { SiteRule, MatchedRule } from './types';
export type { SiteRule, MatchedRule } from './types';
import { githubRule } from './github-rules';
import { redditRule } from './reddit-rules';
import { hackernewsRule } from './hackernews-rules';
import { fortuneRule } from './fortune-rules';

const RULES: SiteRule[] = [
  githubRule,
  redditRule,
  hackernewsRule,
  fortuneRule,
];

export function matchSiteRule(url: string): MatchedRule | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  for (const rule of RULES) {
    if (hostMatches(host, rule.hostPattern)) {
      return { siteRule: rule, matchedPattern: rule.hostPattern };
    }
  }

  return null;
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith('.' + suffix);
  }
  return host === pattern;
}

export function buildSitePrompt(rule: SiteRule): string {
  const parts: string[] = [];

  if (rule.skipTerms && rule.skipTerms.length > 0) {
    parts.push(
      `Do NOT translate the following terms, keep them as-is: ${rule.skipTerms.join(', ')}`
    );
  }

  if (rule.promptInstructions) {
    parts.push(rule.promptInstructions);
  }

  return parts.join('\n');
}
