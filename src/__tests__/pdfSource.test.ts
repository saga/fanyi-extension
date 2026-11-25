import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPdfSource, isPdfUrl } from '../entrypoints/utils/pdfSource';

// Vitest runs with the repo as cwd.
const repoRoot = process.cwd();

describe('isPdfUrl', () => {
  it('accepts .pdf URLs with query strings', () => {
    expect(isPdfUrl('https://ieeexplore.ieee.org/ielx8/52/11679123/11679527.pdf?tp=&arnumber=11679527')).toBe(true);
  });

  it('accepts extension-less /pdf/<id> URLs (arXiv style) without naming the host', () => {
    expect(isPdfUrl('https://arxiv.org/pdf/2611.17323')).toBe(true);
    expect(isPdfUrl('https://example.org/pdfs/abc123')).toBe(false); // /pdfs/, not /pdf/
  });

  it('accepts /pdf and explicit pdf format hints', () => {
    expect(isPdfUrl('https://example.org/report/pdf')).toBe(true);
    expect(isPdfUrl('https://example.org/download?format=pdf')).toBe(true);
  });

  it('rejects HTML wrappers and non-HTTP protocols', () => {
    expect(isPdfUrl('https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=11679527')).toBe(false);
    expect(isPdfUrl('https://example.org/pdf/index.html')).toBe(false);
    expect(isPdfUrl('chrome-extension://abc/index.html')).toBe(false);
  });
});

describe('findPdfSource', () => {
  it('detects a direct PDF document', () => {
    const doc = document.implementation.createHTMLDocument();
    expect(findPdfSource(doc, 'https://example.org/a.pdf?x=1')).toEqual({
      url: 'https://example.org/a.pdf?x=1',
      via: 'self',
    });
  });

  it('mines a full-screen PDF iframe from an HTML wrapper', () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML =
      '<iframe src="/ielx8/52/11679123/11679527.pdf?tp=&arnumber=11679527"></iframe>';
    const found = findPdfSource(doc, 'https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=11679527');
    expect(found?.via).toBe('iframe');
    expect(found?.url).toContain('/ielx8/52/11679123/11679527.pdf');
  });

  it('mines PDFs nested in same-origin wrapper iframes', () => {
    const doc = document;
    document.body.innerHTML = '<iframe></iframe>';
    const outer = document.querySelector('iframe')!;
    const inner = document.createElement('iframe');
    inner.src = 'https://example.org/paper.pdf?download=1';
    outer.contentDocument!.body.appendChild(inner);

    const found = findPdfSource(doc, 'https://example.org/reader');
    expect(found?.via).toBe('iframe');
    expect(found?.url).toContain('/paper.pdf');
  });

  it('mines <embed type="application/pdf"> in native viewer shells', () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<embed name="plugin" type="application/pdf" src="/paper">';
    const found = findPdfSource(doc, 'https://example.org/viewer');
    expect(found?.via).toBe('embed');
    expect(found?.url).toContain('/paper');
  });

  it('mines the primary PDF link when a paper page has no rendered object/embed', () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = `
      <main>
        <a href="Solid-State.pdf?v=20261125a">Read the paper</a>
        <a href="Solid-State.pdf?v=20261125a" download>Download PDF</a>
        <a href="/benchmarks/">Replication kit</a>
      </main>`;
    const found = findPdfSource(doc, 'https://example.org/paper/');
    expect(found?.via).toBe('link');
    expect(found?.url).toBe('https://example.org/paper/Solid-State.pdf?v=20261125a');
  });

  it('accepts a single primary PDF link on a /paper/ landing page', () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<a href="/files/paper.pdf">Open the PDF</a>';
    const found = findPdfSource(doc, 'https://example.org/paper/');
    expect(found?.via).toBe('link');
    expect(found?.url).toBe('https://example.org/files/paper.pdf');
  });

  it('does not hijack ordinary articles with one incidental PDF link', () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<article><p>Article text.</p><a href="/appendix.pdf">Download PDF</a></article>';
    expect(findPdfSource(doc, 'https://example.org/blog/post')).toBeNull();
  });

  it('returns null for ordinary pages without a PDF source', () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<p>Hello world</p><iframe src="/related.html"></iframe>';
    expect(findPdfSource(doc, 'https://example.org/article')).toBeNull();
  });
});

describe('PDF routing has no site hardcode', () => {
  it('popup discovers PDFs via iframe mining instead of an arxiv host check', () => {
    const popup = fs.readFileSync(
      path.join(repoRoot, 'src/entrypoints/popup/App.vue'),
      'utf-8',
    );
    expect(popup).not.toContain('arxiv.org');
    expect(popup).toContain("{ action: 'findPdfSource' }");
    expect(popup).toContain('isPdfUrl(currentUrl)');
  });

  it('pdf reader accepts arbitrary PDF URLs and fetches bytes through background', () => {
    const reader = fs.readFileSync(
      path.join(repoRoot, 'src/entrypoints/pdf-reader/main.ts'),
      'utf-8',
    );
    expect(reader).not.toContain('isArxivPdfUrl');
    expect(reader).toContain("action: 'fetchPdfBinary'");
    expect(reader).toContain('isPdfUrl(url)');
  });
});
