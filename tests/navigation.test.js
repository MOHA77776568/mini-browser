'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInput, isAllowedUrl } = require('../src/navigation');

test('normalizes website addresses and keeps explicit HTTP and HTTPS URLs', () => {
  assert.equal(normalizeInput(' example.com/path?q=hello#part '), 'https://example.com/path?q=hello#part');
  assert.equal(normalizeInput('https://example.com'), 'https://example.com/');
  assert.equal(normalizeInput('http://example.com:8080/test'), 'http://example.com:8080/test');
  assert.equal(normalizeInput('example.com:8080/test'), 'https://example.com:8080/test');
  assert.equal(normalizeInput('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeInput('127.0.0.1:8000/test'), 'http://127.0.0.1:8000/test');
  assert.equal(normalizeInput('[::1]:8000/test'), 'http://[::1]:8000/test');
  assert.equal(normalizeInput(''), '');
});

test('treats natural language, including Arabic, as an encoded search', () => {
  const query = 'تصفح الإنترنت بأمان';
  assert.equal(normalizeInput(query), `https://www.google.com/search?q=${encodeURIComponent(query)}`);
  assert.equal(normalizeInput('hello world'), 'https://www.google.com/search?q=hello%20world');
});

test('blocks privileged protocols, embedded credentials and invalid input', () => {
  for (const input of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'ftp://example.com', 'https://user:password@example.com', 'https://']) {
    assert.throws(() => normalizeInput(input));
    assert.equal(isAllowedUrl(input), false);
  }
  assert.throws(() => normalizeInput('a'.repeat(8193)));
  assert.throws(() => normalizeInput('https://example.com\n/path'));
  assert.throws(() => normalizeInput({ url: 'https://example.com' }));
  assert.equal(isAllowedUrl('https://example.com'), true);
  assert.equal(isAllowedUrl('http://localhost:8080/'), true);
});
