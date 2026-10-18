import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentVersion, versionUrls } from '../src/asset-version.ts';

const VERSIONS = new Map([
  ['/app.js', 'aaaaaaaaaa'],
  ['/og-image.png', 'bbbbbbbbbb'],
]);

test('derives a short hex version from the content', () => {
  assert.match(contentVersion('body'), /^[0-9a-f]{10}$/);
  assert.equal(contentVersion('body'), contentVersion(Buffer.from('body')));
});

test('changes the version when the content changes', () => {
  assert.notEqual(contentVersion('console.log(1);'), contentVersion('console.log(2);'));
});

test('versions relative and same-origin asset URLs', () => {
  const html = '<script src="/app.js"></script><meta content="https://tempo-match.hadalin.me/og-image.png">';

  assert.equal(
    versionUrls(html, VERSIONS),
    '<script src="/app.js?v=aaaaaaaaaa"></script>'
      + '<meta content="https://tempo-match.hadalin.me/og-image.png?v=bbbbbbbbbb">',
  );
});

test('leaves page links, other origins and unknown paths alone', () => {
  const html = '<a href="/privacy"></a><a href="https://example.com/app.js"></a><link href="/missing.css">';

  assert.equal(versionUrls(html, VERSIONS), html);
});
