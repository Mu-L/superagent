const http2 = require('http2');
const Stream = require('stream');
const net = require('net');
const tls = require('tls');

const {
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_STATUS,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_AUTHORITY,
  HTTP2_HEADER_HOST,
  HTTP2_HEADER_SET_COOKIE,
  NGHTTP2_CANCEL
} = http2.constants;

function setProtocol(protocol) {
  return {
    request(options) {
      return new Request(protocol, options);
    }
  };
}

function normalizeIpv6Host(host) {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

class Request extends Stream {
  constructor(protocol, options) {
    super();
    const defaultPort = protocol === 'https:' ? 443 : 80;
    const defaultHost = 'localhost';
    const port = options.port || defaultPort;
    const host = options.host || defaultHost;

    delete options.port;
    delete options.host;

    this.method = options.method;
    this.path = options.path;
    this.protocol = protocol;
    this.host = host;

    delete options.method;
    delete options.path;

    const sessionOptions = { ...options };
    if (options.socketPath) {
      sessionOptions.socketPath = options.socketPath;
      sessionOptions.createConnection = this.createUnixConnection.bind(this);
    }

    this._headers = {};

    const normalizedHost = normalizeIpv6Host(host);
    const session = http2.connect(
      `${protocol}//${normalizedHost}:${port}`,
      sessionOptions
    );
    this.setHeader('host', `${normalizedHost}:${port}`);

    session.on('error', (error) => this.emit('error', error));

    this.session = session;
  }

  createUnixConnection(authority, options) {
    switch (this.protocol) {
      case 'http:':
        return net.connect(options.socketPath);
      case 'https:':
        options.ALPNProtocols = ['h2'];
        options.servername = this.host;
        options.allowHalfOpen = true;
        return tls.connect(options.socketPath, options);
      default:
        throw new Error('Unsupported protocol', this.protocol);
    }
  }

  setNoDelay(bool) {
    // We can not use setNoDelay with HTTP/2.
    // Node 10 limits http2session.socket methods to ones safe to use with HTTP/2.
    // See also https://nodejs.org/api/http2.html#http2_http2session_socket
  }

  getFrame() {
    if (this.frame) {
      return this.frame;
    }

    const method = {
      [HTTP2_HEADER_PATH]: this.path,
      [HTTP2_HEADER_METHOD]: this.method
    };

    let headers = this.mapToHttp2Header(this._headers);

    headers = Object.assign(headers, method);

    const frame = this.session.request(headers);

    frame.once('response', (headers, flags) => {
      headers = this.mapToHttpHeader(headers);
      frame.headers = headers;
      frame.statusCode = headers[HTTP2_HEADER_STATUS];
      frame.status = frame.statusCode;
      this.emit('response', frame);
    });

    this._headerSent = true;

    frame.once('drain', () => this.emit('drain'));
    frame.on('error', (error) => this.emit('error', error));
    frame.on('close', () => this.session.close());

    this.frame = frame;
    return frame;
  }

  mapToHttpHeader(headers) {
    const keys = Object.keys(headers);
    const http2Headers = {};
    for (let key of keys) {
      let value = headers[key];
      key = key.toLowerCase();
      switch (key) {
        case HTTP2_HEADER_SET_COOKIE:
          value = Array.isArray(value) ? value : [value];
          break;
        default:
          break;
      }

      http2Headers[key] = value;
    }

    return http2Headers;
  }

  mapToHttp2Header(headers) {
    const keys = Object.keys(headers);
    const http2Headers = {};
    for (let key of keys) {
      let value = headers[key];
      key = key.toLowerCase();
      switch (key) {
        case HTTP2_HEADER_HOST:
          key = HTTP2_HEADER_AUTHORITY;
          value = /^http:\/\/|^https:\/\//.test(value)
            ? new URL(value).host
            : value;
          break;
        default:
          break;
      }

      http2Headers[key] = value;
    }

    return http2Headers;
  }

  setHeader(name, value) {
    this._headers[name.toLowerCase()] = value;
  }

  getHeader(name) {
    return this._headers[name.toLowerCase()];
  }

  write(data, encoding) {
    const frame = this.getFrame();
    return frame.write(data, encoding);
  }

  pipe(stream, options) {
    const frame = this.getFrame();
    return frame.pipe(stream, options);
  }

  end(data) {
    const frame = this.getFrame();
    frame.end(data);
  }

  abort(data) {
    const frame = this.getFrame();
    frame.close(NGHTTP2_CANCEL);
    this.session.destroy();
  }
}

exports.setProtocol = setProtocol;
