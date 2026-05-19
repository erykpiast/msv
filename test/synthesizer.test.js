'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Redirect ~/.msv to a temp dir so appendLog calls don't touch the real filesystem.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'synthesizer-test-'));
process.env.MSV_ROOT = path.join(tmpHome, '.msv');
fs.mkdirSync(path.join(process.env.MSV_ROOT, 'ideas', 'i_test', 'logs'), { recursive: true });

const { renderFindings, renderFindingsText } = require('../src/agents/synthesizer');

// ---------------------------------------------------------------------------
// renderFindings — unit tests
// ---------------------------------------------------------------------------

test('renderFindings deduplicates source_url across findings', () => {
  const refs = renderFindings([{
    researcher_reports: [
      { findings: [{ finding_id: 'f1', source_url: 'https://x.com', content: 'A' }] },
      { findings: [{ finding_id: 'f2', source_url: 'https://x.com', content: 'B' }] },
    ],
  }]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, 'https://x.com');
});

test('renderFindings skips findings with no source_url', () => {
  const refs = renderFindings([{
    researcher_reports: [
      { findings: [{ finding_id: 'f1', content: 'no url here' }] },
      { findings: [{ finding_id: 'f2', source_url: 'https://example.com', content: 'has url' }] },
    ],
  }]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, 'https://example.com');
});

test('renderFindings caps at 30 refs', () => {
  const findings = Array.from({ length: 50 }, (_, i) => ({
    finding_id: `f${i}`,
    source_url: `https://example.com/${i}`,
    content: `content ${i}`,
  }));
  const refs = renderFindings([{ researcher_reports: [{ findings }] }]);
  assert.equal(refs.length, 30);
});

test('renderFindings sorts by quality: primary before secondary before indirect', () => {
  const refs = renderFindings([{
    researcher_reports: [{
      findings: [
        { finding_id: 'f1', source_url: 'https://indirect.com', content: 'c', quality: 'indirect' },
        { finding_id: 'f2', source_url: 'https://primary.com', content: 'a', quality: 'primary' },
        { finding_id: 'f3', source_url: 'https://secondary.com', content: 'b', quality: 'secondary' },
      ],
    }],
  }]);
  assert.equal(refs[0].url, 'https://primary.com');
  assert.equal(refs[1].url, 'https://secondary.com');
  assert.equal(refs[2].url, 'https://indirect.com');
});

test('renderFindings truncates source_title to 120 chars', () => {
  const longTitle = 'A'.repeat(200);
  const refs = renderFindings([{
    researcher_reports: [{
      findings: [{ finding_id: 'f1', source_url: 'https://x.com', source_title: longTitle, content: 'c' }],
    }],
  }]);
  assert.equal(refs[0].title.length, 120);
});

test('renderFindings truncates content to 200 chars', () => {
  const longContent = 'B'.repeat(300);
  const refs = renderFindings([{
    researcher_reports: [{
      findings: [{ finding_id: 'f1', source_url: 'https://x.com', content: longContent }],
    }],
  }]);
  assert.equal(refs[0].content.length, 200);
});

test('renderFindings handles empty pairDebates', () => {
  assert.deepEqual(renderFindings([]), []);
  assert.deepEqual(renderFindings(null), []);
  assert.deepEqual(renderFindings(undefined), []);
});

// ---------------------------------------------------------------------------
// renderFindingsText — unit tests
// ---------------------------------------------------------------------------

test('renderFindingsText returns placeholder when refs is empty', () => {
  assert.equal(renderFindingsText([]), '(no source URLs in this run)');
});

test('renderFindingsText formats refs with url, title, quality, content', () => {
  const text = renderFindingsText([{
    url: 'https://x.com',
    title: 'Example',
    quality: 'primary',
    content: 'some content',
  }]);
  assert.ok(text.includes('https://x.com'));
  assert.ok(text.includes('Example'));
  assert.ok(text.includes('primary'));
  assert.ok(text.includes('some content'));
});
