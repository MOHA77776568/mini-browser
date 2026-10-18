'use strict';

const MAX_INPUT_LENGTH = 8192;

function isAllowedUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_INPUT_LENGTH) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function normalizeInput(value) {
  if (typeof value !== 'string') throw new Error('Please enter a website address or search.');
  const input = value.trim();
  if (input.length > MAX_INPUT_LENGTH) throw new Error('This address is too long.');
  if (!input) return '';
  if (/[\u0000-\u001f\u007f]/u.test(input)) throw new Error('This address contains invalid characters.');

  const host = input.split(/[/?#]/u)[0];
  const hostWithPort = /^(?:localhost|[\w.-]+\.[\w.-]+|\[[\da-f:]+\]):\d+$/iu.test(host);
  const hasScheme = /^[a-z][a-z\d+.-]*:/iu.test(input) && !hostWithPort;
  if (hasScheme) {
    if (!/^https?:\/\//iu.test(input) || !isAllowedUrl(input)) {
      throw new Error('Only HTTP and HTTPS websites are supported.');
    }
    return new URL(input).href;
  }

  if (!/\s/u.test(input)) {
    try {
      const candidate = new URL(`https://${input}`);
      const hostname = candidate.hostname;
      if (hostname === 'localhost' || hostname.includes('.') || /^\[[\da-f:]+\]$/iu.test(hostname)) {
        if (!isAllowedUrl(candidate.href)) throw new Error('Invalid website address.');
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '0.0.0.0') {
          candidate.protocol = 'http:';
        }
        return candidate.href;
      }
    } catch (error) {
      if (error.message === 'Invalid website address.') throw error;
    }
  }

  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

module.exports = { normalizeInput, isAllowedUrl };
