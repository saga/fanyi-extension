import { describe, expect, it } from 'vitest';
import { getDomainParkingPageMessage } from '../entrypoints/utils/domainParkingGuard';

function makeDocument(title: string, bodyText: string): Document {
  const doc = document.implementation.createHTMLDocument('');
  doc.title = title;
  doc.body.textContent = bodyText;
  return doc;
}

describe('webpage domain parking guard', () => {
  it('blocks the https.com-style parking template before translation', () => {
    const doc = makeDocument(
      'https.com - https Resources and Information.',
      'https.com Privacy Policy',
    );
    const message = getDomainParkingPageMessage(doc, 'https://s.sunxiunan.com/article/894?session=secret');
    expect(message).toContain('已停止网页翻译');
    expect(message).toContain('https.com - https Resources and Information.');
    expect(message).toContain('https://s.sunxiunan.com/article/894');
    expect(message).not.toContain('session=secret');
  });

  it('blocks explicit domain-for-sale pages', () => {
    expect(getDomainParkingPageMessage(
      makeDocument('Welcome', 'This domain may be for sale. Buy this domain today.'),
      'https://example.com/',
    )).toContain('疑似域名停放页');
  });

  it('does not block normal articles that discuss domains', () => {
    expect(getDomainParkingPageMessage(
      makeDocument('How DNS works', 'This article explains domain parking and DNS configuration.'),
      'https://example.com/blog/dns',
    )).toBeNull();
  });
});
