/**
 * Module dependencies.
 */

const { format } = require('url');
const Stream = require('stream');
const https = require('https');
const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const util = require('util');
const qs = require('qs');
const mime = require('mime');
let methods = require('methods');
const FormData = require('form-data');
const formidable = require('formidable');
const debug = require('debug')('superagent');
const CookieJar = require('cookiejar');
const safeStringify = require('fast-safe-stringify');

const utils = require('../utils');
const RequestBase = require('../request-base');
const http2 = require('./http2wrapper');
const { decompress } = require('./unzip');
const Response = require('./response');

const { mixin, hasOwn, isBrotliEncoding, isGzipOrDeflateEncoding } = utils;
const { chooseDecompresser } = require('./decompress');

function request(method, url) {
  // callback
  if (typeof url === 'function') {
    return new exports.Request('GET', method).end(url);
  }

  // url first
  if (arguments.length === 1) {
    return new exports.Request('GET', method);
  }

  return new exports.Request(method, url);
}

module.exports = request;
exports = module.exports;

/**
 * Expose `Request`.
 */

exports.Request = Request;

/**
 * Expose the agent function
 */

exports.agent = require('./agent');

/**
 * Noop.
 */

function noop() {}

/**
 * Expose `Response`.
 */

exports.Response = Response;

/**
 * Define "form" mime type.
 */

mime.define(
  {
    'application/x-www-form-urlencoded': ['form', 'urlencoded', 'form-data']
  },
  true
);

/**
 * Protocol map.
 */

exports.protocols = {
  'http:': http,
  'https:': https,
  'http2:': http2
};

/**
 * Default serialization map.
 *
 *     superagent.serialize['application/xml'] = function(obj){
 *       return 'generated xml here';
 *     };
 *
 */

exports.serialize = {
  'application/x-www-form-urlencoded': (obj) => {
    return qs.stringify(obj, { indices: false, strictNullHandling: true });
  },
  'application/json': safeStringify
};

/**
 * Default parsers.
 *
 *     superagent.parse['application/xml'] = function(res, fn){
 *       fn(null, res);
 *     };
 *
 */

exports.parse = require('./parsers');

/**
 * Default buffering map. Can be used to set certain
 * response types to buffer/not buffer.
 *
 *     superagent.buffer['application/xml'] = true;
 */
exports.buffer = {};

/**
 * Initialize internal header tracking properties on a request instance.
 *
 * @param {Object} req the instance
 * @api private
 */
function _initHeaders(request_) {
  request_._header = {
    // coerces header names to lowercase
  };
  request_.header = {
    // preserves header name case
  };
}

/**
 * Initialize a new `Request` with the given `method` and `url`.
 *
 * @param {String} method
 * @param {String|Object} url
 * @api public
 */

function Request(method, url) {
  Stream.call(this);
  if (typeof url !== 'string') url = format(url);
  this._enableHttp2 = Boolean(process.env.HTTP2_TEST); // internal only
  this._agent = false;
  this._formData = null;
  this.method = method;
  this.url = url;
  _initHeaders(this);
  this.writable = true;
  this._redirects = 0;
  this.redirects(method === 'HEAD' ? 0 : 5);
  this.cookies = '';
  this.qs = {};
  this._query = [];
  this.qsRaw = this._query; // Unused, for backwards compatibility only
  this._redirectList = [];
  this._streamRequest = false;
  this._lookup = undefined;
  this.once('end', this.clearTimeout.bind(this));
}

/**
 * Inherit from `Stream` (which inherits from `EventEmitter`).
 * Mixin `RequestBase`.
 */
util.inherits(Request, Stream);

mixin(Request.prototype, RequestBase.prototype);

/**
 * Enable or Disable http2.
 *
 * Enable http2.
 *
 * ``` js
 * request.get('http://localhost/')
 *   .http2()
 *   .end(callback);
 *
 * request.get('http://localhost/')
 *   .http2(true)
 *   .end(callback);
 * ```
 *
 * Disable http2.
 *
 * ``` js
 * request = request.http2();
 * request.get('http://localhost/')
 *   .http2(false)
 *   .end(callback);
 * ```
 *
 * @param {Boolean} enable
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.http2 = function (bool) {
  if (exports.protocols['http2:'] === undefined) {
    throw new Error(
      'superagent: this version of Node.js does not support http2'
    );
  }

  this._enableHttp2 = bool === undefined ? true : bool;
  return this;
};

/**
 * Queue the given `file` as an attachment to the specified `field`,
 * with optional `options` (or filename).
 *
 * ``` js
 * request.post('http://localhost/upload')
 *   .attach('field', Buffer.from('<b>Hello world</b>'), 'hello.html')
 *   .end(callback);
 * ```
 *
 * A filename may also be used:
 *
 * ``` js
 * request.post('http://localhost/upload')
 *   .attach('files', 'image.jpg')
 *   .end(callback);
 * ```
 *
 * @param {String} field
 * @param {String|fs.ReadStream|Buffer} file
 * @param {String|Object} options
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.attach = function (field, file, options) {
  if (file) {
    if (this._data) {
      throw new Error("superagent can't mix .send() and .attach()");
    }

    let o = options || {};
    if (typeof options === 'string') {
      o = { filename: options };
    }

    if (typeof file === 'string') {
      if (!o.filename) o.filename = file;
      debug('creating `fs.ReadStream` instance for file: %s', file);
      file = fs.createReadStream(file);
      file.on('error', (error) => {
        const formData = this._getFormData();
        formData.emit('error', error);
      });
    } else if (!o.filename && file.path) {
      o.filename = file.path;
    }

    this._getFormData().append(field, file, o);
  }

  return this;
};

Request.prototype._getFormData = function () {
  if (!this._formData) {
    this._formData = new FormData();
    this._formData.on('error', (error) => {
      debug('FormData error', error);
      if (this.called) {
        // The request has already finished and the callback was called.
        // Silently ignore the error.
        return;
      }

      this.callback(error);
      this.abort();
    });
  }

  return this._formData;
};

/**
 * Gets/sets the `Agent` to use for this HTTP request. The default (if this
 * function is not called) is to opt out of connection pooling (`agent: false`).
 *
 * @param {http.Agent} agent
 * @return {http.Agent}
 * @api public
 */

Request.prototype.agent = function (agent) {
  if (arguments.length === 0) return this._agent;
  this._agent = agent;
  return this;
};

/**
 * Gets/sets the `lookup` function to use custom DNS resolver.
 *
 * @param {Function} lookup
 * @return {Function}
 * @api public
 */

Request.prototype.lookup = function (lookup) {
  if (arguments.length === 0) return this._lookup;
  this._lookup = lookup;
  return this;
};

/**
 * Set _Content-Type_ response header passed through `mime.getType()`.
 *
 * Examples:
 *
 *      request.post('/')
 *        .type('xml')
 *        .send(xmlstring)
 *        .end(callback);
 *
 *      request.post('/')
 *        .type('json')
 *        .send(jsonstring)
 *        .end(callback);
 *
 *      request.post('/')
 *        .type('application/json')
 *        .send(jsonstring)
 *        .end(callback);
 *
 * @param {String} type
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.type = function (type) {
  return this.set(
    'Content-Type',
    type.includes('/') ? type : mime.getType(type)
  );
};

/**
 * Set _Accept_ response header passed through `mime.getType()`.
 *
 * Examples:
 *
 *      superagent.types.json = 'application/json';
 *
 *      request.get('/agent')
 *        .accept('json')
 *        .end(callback);
 *
 *      request.get('/agent')
 *        .accept('application/json')
 *        .end(callback);
 *
 * @param {String} accept
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.accept = function (type) {
  return this.set('Accept', type.includes('/') ? type : mime.getType(type));
};

/**
 * Add query-string `val`.
 *
 * Examples:
 *
 *   request.get('/shoes')
 *     .query('size=10')
 *     .query({ color: 'blue' })
 *
 * @param {Object|String} val
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.query = function (value) {
  if (typeof value === 'string') {
    this._query.push(value);
  } else {
    Object.assign(this.qs, value);
  }

  return this;
};

/**
 * Write raw `data` / `encoding` to the socket.
 *
 * @param {Buffer|String} data
 * @param {String} encoding
 * @return {Boolean}
 * @api public
 */

Request.prototype.write = function (data, encoding) {
  const request_ = this.request();
  if (!this._streamRequest) {
    this._streamRequest = true;
  }

  return request_.write(data, encoding);
};

/**
 * Pipe the request body to `stream`.
 *
 * @param {Stream} stream
 * @param {Object} options
 * @return {Stream}
 * @api public
 */

Request.prototype.pipe = function (stream, options) {
  this.piped = true; // HACK...
  this.buffer(false);
  this.end();
  return this._pipeContinue(stream, options);
};

Request.prototype._pipeContinue = function (stream, options) {
  this.req.once('response', (res) => {
    // redirect
    if (
      isRedirect(res.statusCode) &&
      this._redirects++ !== this._maxRedirects
    ) {
      return this._redirect(res) === this
        ? this._pipeContinue(stream, options)
        : undefined;
    }

    this.res = res;
    this._emitResponse();
    if (this._aborted) return;

    if (this._shouldDecompress(res)) {

      let decompresser = chooseDecompresser(res);

      decompresser.on('error', (error) => {
        if (error && error.code === 'Z_BUF_ERROR') {
          // unexpected end of file is ignored by browsers and curl
          stream.emit('end');
          return;
        }

        stream.emit('error', error);
      });
      res.pipe(decompresser).pipe(stream, options);
      // don't emit 'end' until decompresser has completed writing all its data.
      decompresser.once('end', () => this.emit('end'));
    } else {
      res.pipe(stream, options);
      res.once('end', () => this.emit('end'));
    }
  });
  return stream;
};

/**
 * Enable / disable buffering.
 *
 * @return {Boolean} [val]
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.buffer = function (value) {
  this._buffer = value !== false;
  return this;
};

/**
 * Redirect to `url
 *
 * @param {IncomingMessage} res
 * @return {Request} for chaining
 * @api private
 */

Request.prototype._redirect = function (res) {
  let url = res.headers.location;
  if (!url) {
    return this.callback(new Error('No location header for redirect'), res);
  }

  debug('redirect %s -> %s', this.url, url);

  // location
  url = new URL(url, this.url).href;

  // ensure the response is being consumed
  // this is required for Node v0.10+
  res.resume();

  let headers = this.req.getHeaders ? this.req.getHeaders() : this.req._headers;

  const changesOrigin = new URL(url).host !== new URL(this.url).host;

  // implementation of 302 following defacto standard
  if (res.statusCode === 301 || res.statusCode === 302) {
    // strip Content-* related fields
    // in case of POST etc
    headers = utils.cleanHeader(headers, changesOrigin);

    // force GET
    this.method = this.method === 'HEAD' ? 'HEAD' : 'GET';

    // clear data
    this._data = null;
  }

  // 303 is always GET
  if (res.statusCode === 303) {
    // strip Content-* related fields
    // in case of POST etc
    headers = utils.cleanHeader(headers, changesOrigin);

    // force method
    this.method = 'GET';

    // clear data
    this._data = null;
  }

  // 307 preserves method
  // 308 preserves method
  delete headers.host;

  delete this.req;
  delete this._formData;

  // remove all add header except User-Agent
  _initHeaders(this);

  // redirect
  this.res = res;
  this._endCalled = false;
  this.url = url;
  this.qs = {};
  this._query.length = 0;
  this.set(headers);
  this._emitRedirect();
  this._redirectList.push(this.url);
  this.end(this._callback);
  return this;
};

/**
 * Set Authorization field value with `user` and `pass`.
 *
 * Examples:
 *
 *   .auth('tobi', 'learnboost')
 *   .auth('tobi:learnboost')
 *   .auth('tobi')
 *   .auth(accessToken, { type: 'bearer' })
 *
 * @param {String} user
 * @param {String} [pass]
 * @param {Object} [options] options with authorization type 'basic' or 'bearer' ('basic' is default)
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.auth = function (user, pass, options) {
  if (arguments.length === 1) pass = '';
  if (typeof pass === 'object' && pass !== null) {
    // pass is optional and can be replaced with options
    options = pass;
    pass = '';
  }

  if (!options) {
    options = { type: 'basic' };
  }

  const encoder = (string) => Buffer.from(string).toString('base64');

  return this._auth(user, pass, options, encoder);
};

/**
 * Set the certificate authority option for https request.
 *
 * @param {Buffer | Array} cert
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.ca = function (cert) {
  this._ca = cert;
  return this;
};

/**
 * Set the client certificate key option for https request.
 *
 * @param {Buffer | String} cert
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.key = function (cert) {
  this._key = cert;
  return this;
};

/**
 * Set the key, certificate, and CA certs of the client in PFX or PKCS12 format.
 *
 * @param {Buffer | String} cert
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.pfx = function (cert) {
  if (typeof cert === 'object' && !Buffer.isBuffer(cert)) {
    this._pfx = cert.pfx;
    this._passphrase = cert.passphrase;
  } else {
    this._pfx = cert;
  }

  return this;
};

/**
 * Set the client certificate option for https request.
 *
 * @param {Buffer | String} cert
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.cert = function (cert) {
  this._cert = cert;
  return this;
};

/**
 * Do not reject expired or invalid TLS certs.
 * sets `rejectUnauthorized=true`. Be warned that this allows MITM attacks.
 *
 * @return {Request} for chaining
 * @api public
 */

Request.prototype.disableTLSCerts = function () {
  this._disableTLSCerts = true;
  return this;
};

/**
 * Return an http[s] request.
 *
 * @return {OutgoingMessage}
 * @api private
 */

// eslint-disable-next-line complexity
Request.prototype.request = function () {
  if (this.req) return this.req;

  const options = {};

  try {
    const query = qs.stringify(this.qs, {
      indices: false,
      strictNullHandling: true
    });
    if (query) {
      this.qs = {};
      this._query.push(query);
    }

    this._finalizeQueryString();
  } catch (err) {
    return this.emit('error', err);
  }

  let { url: urlString } = this;
  const retries = this._retries;

  // default to http://
  if (urlString.indexOf('http') !== 0) urlString = `http://${urlString}`;
  const url = new URL(urlString);
  let { protocol } = url;
  let path = `${url.pathname}${url.search}`;

  // support unix sockets
  if (/^https?\+unix:/.test(protocol) === true) {
    // get the protocol
    protocol = `${protocol.split('+')[0]}:`;

    // get the socket path
    options.socketPath = url.hostname.replace(/%2F/g, '/');
    url.host = '';
    url.hostname = '';
  }

  // Override IP address of a hostname
  if (this._connectOverride) {
    const { hostname } = url;
    const match =
      hostname in this._connectOverride
        ? this._connectOverride[hostname]
        : this._connectOverride['*'];
    if (match) {
      // backup the real host
      if (!this._header.host) {
        this.set('host', url.host);
      }

      let newHost;
      let newPort;

      if (typeof match === 'object') {
        newHost = match.host;
        newPort = match.port;
      } else {
        newHost = match;
        newPort = url.port;
      }

      // wrap [ipv6]
      url.host = /:/.test(newHost) ? `[${newHost}]` : newHost;
      if (newPort) {
        url.host += `:${newPort}`;
        url.port = newPort;
      }

      url.hostname = newHost;
    }
  }

  // options
  options.method = this.method;
  options.port = url.port;
  options.path = path;
  options.host = utils.normalizeHostname(url.hostname); // ex: [::1] -> ::1
  options.ca = this._ca;
  options.key = this._key;
  options.pfx = this._pfx;
  options.cert = this._cert;
  options.passphrase = this._passphrase;
  options.agent = this._agent;
  options.lookup = this._lookup;
  options.rejectUnauthorized =
    typeof this._disableTLSCerts === 'boolean'
      ? !this._disableTLSCerts
      : process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';

  // Allows request.get('https://1.2.3.4/').set('Host', 'example.com')
  if (this._header.host) {
    options.servername = this._header.host.replace(/:\d+$/, '');
  }

  if (
    this._trustLocalhost &&
    /^(?:localhost|127\.0\.0\.\d+|(0*:)+:0*1)$/.test(url.hostname)
  ) {
    options.rejectUnauthorized = false;
  }

  // initiate request
  const module_ = this._enableHttp2
    ? exports.protocols['http2:'].setProtocol(protocol)
    : exports.protocols[protocol];

  // request
  this.req = module_.request(options);
  const { req } = this;

  // set tcp no delay
  req.setNoDelay(true);

  if (options.method !== 'HEAD') {
    req.setHeader('Accept-Encoding', 'gzip, deflate');
  }

  this.protocol = protocol;
  this.host = url.host;

  // expose events
  req.once('drain', () => {
    this.emit('drain');
  });

  req.on('error', (error) => {
    // flag abortion here for out timeouts
    // because node will emit a faux-error "socket hang up"
    // when request is aborted before a connection is made
    if (this._aborted) return;
    // if not the same, we are in the **old** (cancelled) request,
    // so need to continue (same as for above)
    if (this._retries !== retries) return;
    // if we've received a response then we don't want to let
    // an error in the request blow up the response
    if (this.response) return;
    this.callback(error);
  });

  // auth
  if (url.username || url.password) {
    this.auth(url.username, url.password);
  }

  if (this.username && this.password) {
    this.auth(this.username, this.password);
  }

  for (const key in this.header) {
    if (hasOwn(this.header, key)) req.setHeader(key, this.header[key]);
  }

  // add cookies
  if (this.cookies) {
    if (hasOwn(this._header, 'cookie')) {
      // merge
      const temporaryJar = new CookieJar.CookieJar();
      temporaryJar.setCookies(this._header.cookie.split('; '));
      temporaryJar.setCookies(this.cookies.split('; '));
      req.setHeader(
        'Cookie',
        temporaryJar.getCookies(CookieJar.CookieAccessInfo.All).toValueString()
      );
    } else {
      req.setHeader('Cookie', this.cookies);
    }
  }

  return req;
};

/**
 * Invoke the callback with `err` and `res`
 * and handle arity check.
 *
 * @param {Error} err
 * @param {Response} res
 * @api private
 */

Request.prototype.callback = function (error, res) {
  if (this._shouldRetry(error, res)) {
    return this._retry();
  }

  // Avoid the error which is emitted from 'socket hang up' to cause the fn undefined error on JS runtime.
  const fn = this._callback || noop;
  this.clearTimeout();
  if (this.called) return console.warn('superagent: double callback bug');
  this.called = true;

  if (!error) {
    try {
      if (!this._isResponseOK(res)) {
        let message = 'Unsuccessful HTTP response';
        if (res) {
          message = http.STATUS_CODES[res.status] || message;
        }

        error = new Error(message);
        error.status = res ? res.status : undefined;
      }
    } catch (err) {
      error = err;
      error.status = error.status || (res ? res.status : undefined);
    }
  }

  // It's important that the callback is called outside try/catch
  // to avoid double callback
  if (!error) {
    return fn(null, res);
  }

  error.response = res;
  if (this._maxRetries) error.retries = this._retries - 1;

  // only emit error event if there is a listener
  // otherwise we assume the callback to `.end()` will get the error
  if (error && this.listeners('error').length > 0) {
    this.emit('error', error);
  }

  fn(error, res);
};

/**
 * Check if `obj` is a host object,
 *
 * @param {Object} obj host object
 * @return {Boolean} is a host object
 * @api private
 */
Request.prototype._isHost = function (object) {
  return (
    Buffer.isBuffer(object) ||
    object instanceof Stream ||
    object instanceof FormData
  );
};

/**
 * Initiate request, invoking callback `fn(err, res)`
 * with an instanceof `Response`.
 *
 * @param {Function} fn
 * @return {Request} for chaining
 * @api public
 */

Request.prototype._emitResponse = function (body, files) {
  const response = new Response(this);
  this.response = response;
  response.redirects = this._redirectList;
  if (undefined !== body) {
    response.body = body;
  }

  response.files = files;
  if (this._endCalled) {
    response.pipe = function () {
      throw new Error(
        "end() has already been called, so it's too late to start piping"
      );
    };
  }

  this.emit('response', response);
  return response;
};

/**
 * Emit `redirect` event, passing an instanceof `Response`.
 *
 * @api private
 */

Request.prototype._emitRedirect = function () {
  const response = new Response(this);
  response.redirects = this._redirectList;
  this.emit('redirect', response);
};

Request.prototype.end = function (fn) {
  this.request();
  debug('%s %s', this.method, this.url);

  if (this._endCalled) {
    throw new Error(
      '.end() was called twice. This is not supported in superagent'
    );
  }

  this._endCalled = true;

  // store callback
  this._callback = fn || noop;

  this._end();
};

Request.prototype._end = function () {
  if (this._aborted)
    return this.callback(
      new Error('The request has been aborted even before .end() was called')
    );

  let data = this._data;
  const { req } = this;
  const { method } = this;

  this._setTimeouts();

  // body
  if (method !== 'HEAD' && !req._headerSent) {
    // serialize stuff
    if (typeof data !== 'string') {
      let contentType = req.getHeader('Content-Type');
      // Parse out just the content type from the header (ignore the charset)
      if (contentType) contentType = contentType.split(';')[0];
      let serialize = this._serializer || exports.serialize[contentType];
      if (!serialize && isJSON(contentType)) {
        serialize = exports.serialize['application/json'];
      }

      if (serialize) data = serialize(data);
    }

    // content-length
    if (data && !req.getHeader('Content-Length')) {
      req.setHeader(
        'Content-Length',
        Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data)
      );
    }
  }

  // response
  // eslint-disable-next-line complexity
  req.once('response', (res) => {
    debug('%s %s -> %s', this.method, this.url, res.statusCode);

    if (this._responseTimeoutTimer) {
      clearTimeout(this._responseTimeoutTimer);
    }

    if (this.piped) {
      return;
    }

    const max = this._maxRedirects;
    const mime = utils.type(res.headers['content-type'] || '') || 'text/plain';
    let type = mime.split('/')[0];
    if (type) type = type.toLowerCase().trim();
    const multipart = type === 'multipart';
    const redirect = isRedirect(res.statusCode);
    const responseType = this._responseType;

    this.res = res;

    // redirect
    if (redirect && this._redirects++ !== max) {
      return this._redirect(res);
    }

    if (this.method === 'HEAD') {
      this.emit('end');
      this.callback(null, this._emitResponse());
      return;
    }

    // zlib support
    if (this._shouldDecompress(res)) {
      decompress(req, res);
    }

    let buffer = this._buffer;
    if (buffer === undefined && mime in exports.buffer) {
      buffer = Boolean(exports.buffer[mime]);
    }

    let parser = this._parser;
    if (undefined === buffer && parser) {
      console.warn(
        "A custom superagent parser has been set, but buffering strategy for the parser hasn't been configured. Call `req.buffer(true or false)` or set `superagent.buffer[mime] = true or false`"
      );
      buffer = true;
    }

    if (!parser) {
      if (responseType) {
        parser = exports.parse.image; // It's actually a generic Buffer
        buffer = true;
      } else if (multipart) {
        const form = formidable.formidable();
        parser = (res, callback) => {
          // Create a PassThrough stream that acts as a proper HTTP request
          const bridgeStream = new Stream.PassThrough();

          // Add HTTP request properties from the current request context
          bridgeStream.method = this.method || 'POST';
          bridgeStream.url = this.url || '/';
          bridgeStream.httpVersion = res.httpVersion || '1.1';
          bridgeStream.headers = res.headers || {};
          bridgeStream.socket = res.socket || { readable: true };

          // Pipe the response data through the bridge stream
          res.pipe(bridgeStream);

          form.parse(bridgeStream, (err, fields, files) => {
            if (err) return callback(err);

            // Formidable v3 always returns arrays, but SuperAgent expects single values
            // Flatten single-item arrays to maintain backward compatibility
            const flattenedFields = {};
            if (fields) {
              for (const key in fields) {
                const value = fields[key];
                flattenedFields[key] = Array.isArray(value) && value.length === 1 ? value[0] : value;
              }
            }

            const flattenedFiles = {};
            if (files) {
              for (const key in files) {
                const value = files[key];
                flattenedFiles[key] = Array.isArray(value) && value.length === 1 ? value[0] : value;
              }
            }

            // Return flattened fields as the object parameter to match SuperAgent's expected format
            callback(null, flattenedFields, flattenedFiles);
          });
        };
        buffer = true;
      } else if (isBinary(mime)) {
        parser = exports.parse.image;
        buffer = true; // For backwards-compatibility buffering default is ad-hoc MIME-dependent
      } else if (exports.parse[mime]) {
        parser = exports.parse[mime];
      } else if (type === 'text') {
        parser = exports.parse.text;
        buffer = buffer !== false;
        // everyone wants their own white-labeled json
      } else if (isJSON(mime)) {
        parser = exports.parse['application/json'];
        buffer = buffer !== false;
      } else if (buffer) {
        parser = exports.parse.text;
      } else if (undefined === buffer) {
        parser = exports.parse.image; // It's actually a generic Buffer
        buffer = true;
      }
    }

    // by default only buffer text/*, json and messed up thing from hell
    if ((undefined === buffer && isText(mime)) || isJSON(mime)) {
      buffer = true;
    }

    this._resBuffered = buffer;
    let parserHandlesEnd = false;
    if (buffer) {
      // Protectiona against zip bombs and other nuisance
      let responseBytesLeft = this._maxResponseSize || 200000000;
      res.on('data', (buf) => {
        responseBytesLeft -= buf.byteLength || buf.length > 0 ? buf.length : 0;
        if (responseBytesLeft < 0) {
          // This will propagate through error event
          const error = new Error('Maximum response size reached');
          error.code = 'ETOOLARGE';
          // Parsers aren't required to observe error event,
          // so would incorrectly report success
          parserHandlesEnd = false;
          // Will not emit error event
          res.destroy(error);
          // so we do callback now
          this.callback(error, null);
        }
      });
    }

    if (parser) {
      try {
        // Unbuffered parsers are supposed to emit response early,
        // which is weird BTW, because response.body won't be there.
        parserHandlesEnd = buffer;

        parser(res, (error, object, files) => {
          if (this.timedout) {
            // Timeout has already handled all callbacks
            return;
          }

          // Intentional (non-timeout) abort is supposed to preserve partial response,
          // even if it doesn't parse.
          if (error && !this._aborted) {
            return this.callback(error);
          }

          if (parserHandlesEnd) {
            this.emit('end');
            this.callback(null, this._emitResponse(object, files));
          }
        });
      } catch (err) {
        this.callback(err);
        return;
      }
    }

    this.res = res;

    // unbuffered
    if (!buffer) {
      debug('unbuffered %s %s', this.method, this.url);
      this.callback(null, this._emitResponse());
      if (multipart) return; // allow multipart to handle end event
      res.once('end', () => {
        debug('end %s %s', this.method, this.url);
        this.emit('end');
      });
      return;
    }

    // terminating events
    res.once('error', (error) => {
      parserHandlesEnd = false;
      this.callback(error, null);
    });
    if (!parserHandlesEnd)
      res.once('end', () => {
        debug('end %s %s', this.method, this.url);
        // TODO: unless buffering emit earlier to stream
        this.emit('end');
        this.callback(null, this._emitResponse());
      });
  });

  this.emit('request', this);

  const getProgressMonitor = () => {
    const lengthComputable = true;
    const total = req.getHeader('Content-Length');
    let loaded = 0;

    const progress = new Stream.Transform();
    progress._transform = (chunk, encoding, callback) => {
      loaded += chunk.length;
      this.emit('progress', {
        direction: 'upload',
        lengthComputable,
        loaded,
        total
      });
      callback(null, chunk);
    };

    return progress;
  };

  const bufferToChunks = (buffer) => {
    const chunkSize = 16 * 1024; // default highWaterMark value
    const chunking = new Stream.Readable();
    const totalLength = buffer.length;
    const remainder = totalLength % chunkSize;
    const cutoff = totalLength - remainder;

    for (let i = 0; i < cutoff; i += chunkSize) {
      const chunk = buffer.slice(i, i + chunkSize);
      chunking.push(chunk);
    }

    if (remainder > 0) {
      const remainderBuffer = buffer.slice(-remainder);
      chunking.push(remainderBuffer);
    }

    chunking.push(null); // no more data

    return chunking;
  };

  // if a FormData instance got created, then we send that as the request body
  const formData = this._formData;
  if (formData) {
    // set headers
    const headers = formData.getHeaders();
    for (const i in headers) {
      if (hasOwn(headers, i)) {
        debug('setting FormData header: "%s: %s"', i, headers[i]);
        req.setHeader(i, headers[i]);
      }
    }

    // attempt to get "Content-Length" header
    formData.getLength((error, length) => {
      // TODO: Add chunked encoding when no length (if err)
      if (error) debug('formData.getLength had error', error, length);

      debug('got FormData Content-Length: %s', length);
      if (typeof length === 'number') {
        req.setHeader('Content-Length', length);
      }

      formData.pipe(getProgressMonitor()).pipe(req);
    });
  } else if (Buffer.isBuffer(data)) {
    bufferToChunks(data).pipe(getProgressMonitor()).pipe(req);
  } else {
    req.end(data);
  }
};

// Check whether response has a non-0-sized gzip-encoded body
Request.prototype._shouldDecompress = (res) => {
  return hasNonEmptyResponseContent(res) && (isGzipOrDeflateEncoding(res) || isBrotliEncoding(res));
};


/**
 * Overrides DNS for selected hostnames. Takes object mapping hostnames to IP addresses.
 *
 * When making a request to a URL with a hostname exactly matching a key in the object,
 * use the given IP address to connect, instead of using DNS to resolve the hostname.
 *
 * A special host `*` matches every hostname (keep redirects in mind!)
 *
 *      request.connect({
 *        'test.example.com': '127.0.0.1',
 *        'ipv6.example.com': '::1',
 *      })
 */
Request.prototype.connect = function (connectOverride) {
  if (typeof connectOverride === 'string') {
    this._connectOverride = { '*': connectOverride };
  } else if (typeof connectOverride === 'object') {
    this._connectOverride = connectOverride;
  } else {
    this._connectOverride = undefined;
  }

  return this;
};

Request.prototype.trustLocalhost = function (toggle) {
  this._trustLocalhost = toggle === undefined ? true : toggle;
  return this;
};

// generate HTTP verb methods
if (!methods.includes('del')) {
  // create a copy so we don't cause conflicts with
  // other packages using the methods package and
  // npm 3.x
  methods = [...methods];
  methods.push('del');
}

for (let method of methods) {
  const name = method;
  method = method === 'del' ? 'delete' : method;

  method = method.toUpperCase();
  request[name] = (url, data, fn) => {
    const request_ = request(method, url);
    if (typeof data === 'function') {
      fn = data;
      data = null;
    }

    if (data) {
      if (method === 'GET' || method === 'HEAD') {
        request_.query(data);
      } else {
        request_.send(data);
      }
    }

    if (fn) request_.end(fn);
    return request_;
  };
}

/**
 * Check if `mime` is text and should be buffered.
 *
 * @param {String} mime
 * @return {Boolean}
 * @api public
 */

function isText(mime) {
  const parts = mime.split('/');
  let type = parts[0];
  if (type) type = type.toLowerCase().trim();
  let subtype = parts[1];
  if (subtype) subtype = subtype.toLowerCase().trim();

  return type === 'text' || subtype === 'x-www-form-urlencoded';
}

// This is not a catchall, but a start. It might be useful
// in the long run to have file that includes all binary
// content types from https://www.iana.org/assignments/media-types/media-types.xhtml
function isBinary(mime) {
  let [registry, name] = mime.split('/');
  if (registry) registry = registry.toLowerCase().trim();
  if (name) name = name.toLowerCase().trim();
  return (
    ['audio', 'font', 'image', 'video'].includes(registry) ||
    ['gz', 'gzip'].includes(name)
  );
}

/**
 * Check if `mime` is json or has +json structured syntax suffix.
 *
 * @param {String} mime
 * @return {Boolean}
 * @api private
 */

function isJSON(mime) {
  // should match /json or +json
  // but not /json-seq
  return /[/+]json($|[^-\w])/i.test(mime);
}

/**
 * Check if we should follow the redirect `code`.
 *
 * @param {Number} code
 * @return {Boolean}
 * @api private
 */

function isRedirect(code) {
  return [301, 302, 303, 305, 307, 308].includes(code);
}

function hasNonEmptyResponseContent(res) {
  if (res.statusCode === 204 || res.statusCode === 304) {
    // These aren't supposed to have any body
    return false;
  }

  // header content is a string, and distinction between 0 and no information is crucial
  if (res.headers['content-length'] === '0') {
    // We know that the body is empty (unfortunately, this check does not cover chunked encoding)
    return false;
  }

  return true;
}
