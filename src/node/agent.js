/**
 * Module dependencies.
 */

const net = require('node:net');
const { CookieJar } = require('cookiejar');
const { CookieAccessInfo } = require('cookiejar');
const methods = require('methods');
const request = require('../..');
const AgentBase = require('../agent-base');

function defaultCookiePath(pathname) {
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash > 0 ? pathname.slice(0, lastSlash) : '/';
}

/**
 * Whether `requestHost` domain-matches the cookie `domain` attribute
 * (RFC 6265 Section 5.1.3). IP addresses only match themselves.
 *
 * @param {String} requestHost
 * @param {String} domain
 * @return {Boolean}
 * @api private
 */
function domainMatches(requestHost, domain) {
  if (requestHost === domain) return true;
  return (
    requestHost.endsWith(`.${domain}`) &&
    net.isIP(requestHost) === 0 &&
    !/^\[/.test(requestHost)
  );
}

/**
 * Filter Set-Cookie values so that a server can only set cookies for itself.
 *
 * `cookiejar` stores any explicit `Domain` attribute as given, which would
 * let one host plant cookies that the jar then sends to an unrelated host
 * (session fixation across the hosts an agent talks to, e.g. through a
 * redirect chain). Per RFC 6265 Section 5.3 step 6 a cookie whose domain
 * attribute does not domain-match the request host is ignored; a domain
 * without any dot (a bare public suffix such as "com") is ignored as well
 * unless it is the request host itself (e.g. "localhost").
 *
 * @param {String[]} cookies raw Set-Cookie header values
 * @param {String} requestHost lower-cased hostname the response came from
 * @return {String[]}
 * @api private
 */
function filterCookiesForHost(cookies, requestHost) {
  return cookies.filter((cookie) => {
    if (typeof cookie !== 'string') return false;
    const parts = cookie.split(';');
    for (const part of parts.slice(1)) {
      const index = part.indexOf('=');
      const name = (index === -1 ? part : part.slice(0, index))
        .trim()
        .toLowerCase();
      if (name !== 'domain') continue;
      const domain = (index === -1 ? '' : part.slice(index + 1))
        .trim()
        .replace(/^\./, '')
        .toLowerCase();
      // an empty Domain attribute means "host-only"; cookiejar treats it
      // the same way
      if (!domain) return true;
      if (domain !== requestHost && !domain.includes('.')) return false;
      return domainMatches(requestHost, domain);
    }

    return true;
  });
}

/**
 * Initialize a new `Agent`.
 *
 * @api public
 */

class Agent extends AgentBase {
  constructor(options) {
    super();

    this.jar = new CookieJar();

    if (options) {
      if (options.ca) {
        this.ca(options.ca);
      }

      if (options.key) {
        this.key(options.key);
      }

      if (options.pfx) {
        this.pfx(options.pfx);
      }

      if (options.cert) {
        this.cert(options.cert);
      }

      if (options.rejectUnauthorized === false) {
        this.disableTLSCerts();
      }
    }
  }

  /**
   * Save the cookies in the given `res` to
   * the agent's cookie jar for persistence.
   *
   * @param {Response} res
   * @api private
   */
  _saveCookies(res) {
    let cookies = res.headers['set-cookie'];
    if (cookies) {
      const url = new URL((res.request && res.request.url) || '');
      if (!Array.isArray(cookies)) cookies = [cookies];
      cookies = filterCookiesForHost(cookies, url.hostname.toLowerCase());
      if (cookies.length === 0) return;
      this.jar.setCookies(
        cookies,
        url.hostname,
        defaultCookiePath(url.pathname)
      );
    }
  }

  /**
   * Attach cookies when available to the given `req`.
   *
   * @param {Request} req
   * @api private
   */
  _attachCookies(request_) {
    const url = new URL(request_.url);
    const access = new CookieAccessInfo(
      url.hostname,
      url.pathname,
      url.protocol === 'https:'
    );
    const cookies = this.jar.getCookies(access).toValueString();
    request_.cookies = cookies;
  }
}

for (const name of methods) {
  const method = name.toUpperCase();
  if (method === 'QUERY') continue;
  Agent.prototype[name] = function (url, fn) {
    const request_ = new request.Request(method, url);

    request_.on('response', this._saveCookies.bind(this));
    request_.on('pre-redirect', this._saveCookies.bind(this));
    request_.on('redirect', this._attachCookies.bind(this, request_));
    this._setDefaults(request_);
    this._attachCookies(request_);

    if (fn) {
      request_.end(fn);
    }

    return request_;
  };
}

Agent.prototype.del = Agent.prototype.delete;

// create a Proxy that can instantiate a new Agent without using `new` keyword
// (for backward compatibility and chaining)
const proxyAgent = new Proxy(Agent, {
  apply(target, thisArgument, argumentsList) {
    // eslint-disable-next-line new-cap
    return new target(...argumentsList);
  }
});

module.exports = proxyAgent;
