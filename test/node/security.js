'use strict';

/**
 * Hardening against hostile servers: redirect targets, prototype keys in
 * response metadata, response size accounting, decompression bombs,
 * unbuffered responses and cookie scoping.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');
const zlib = require('node:zlib');
const { Buffer } = require('node:buffer');
const request = require('../support/client');
const express = require('../support/express');

let http = require('node:http');

if (process.env.HTTP2_TEST) {
  http = require('node:http2');
}

const app = express();
const other = express();
const unixApp = express();
const otherUnixApp = express();

let base = 'http://127.0.0.1';
let server;
let otherBase = 'http://localhost';
let otherServer;
let unixServer;
let otherUnixServer;
let secretHits = 0;

const unixSocketPath = path.join(os.tmpdir(), 'superagent-security.sock');
const otherUnixSocketPath = path.join(
  os.tmpdir(),
  'superagent-security-other.sock'
);
const unixBase = `http+unix://${encodeURIComponent(unixSocketPath)}`;
const otherUnixBase = `http+unix://${encodeURIComponent(otherUnixSocketPath)}`;

// 32 MiB of zeroes compresses to a few tens of KiB
const bomb = zlib.gzipSync(Buffer.alloc(32 * 1024 * 1024));

function listen(server_, target) {
  // Track sockets so `close()` can tear down connections a cancelled
  // request left open (HTTP/2 sessions otherwise keep the server alive).
  const sockets = new Set();
  server_.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server_.destroySockets = () => {
    for (const socket of sockets) socket.destroy();
  };

  return new Promise((resolve, reject) => {
    server_.once('error', reject);
    server_.listen(target, () => resolve(server_));
  });
}

function close(server_) {
  return new Promise((resolve) => {
    if (!server_) return resolve();
    server_.close(() => resolve());
    server_.destroySockets();
  });
}

before(async () => {
  server = await listen(http.createServer(app), 0);
  base += `:${server.address().port}`;
  otherServer = await listen(http.createServer(other), 0);
  otherBase += `:${otherServer.address().port}`;

  if (process.platform !== 'win32') {
    for (const socketPath of [unixSocketPath, otherUnixSocketPath]) {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    }

    unixServer = await listen(http.createServer(unixApp), unixSocketPath);
    otherUnixServer = await listen(
      http.createServer(otherUnixApp),
      otherUnixSocketPath
    );
  }
});

after(async () => {
  await close(server);
  await close(otherServer);
  await close(unixServer);
  await close(otherUnixServer);
});

app.get('/redirect-to', (request_, res) => {
  res.redirect(Number(request_.query.status) || 302, request_.query.to);
});

app.get('/redirect-invalid', (request_, res) => {
  res.set('Location', 'http://[::1');
  res.status(302).end();
});

app.get('/redirect-relative', (request_, res) => {
  res.redirect('/landed');
});

app.get('/landed', (request_, res) => {
  res.send('landed');
});

app.get('/echo-auth', (request_, res) => {
  res.json({ authorization: request_.headers.authorization || null });
});

other.get('/echo-auth', (request_, res) => {
  res.json({ authorization: request_.headers.authorization || null });
});

for (const type of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
  app.get(`/type/${type}`, (request_, res) => {
    res.set('Content-Type', type);
    res.end('hello');
  });
}

app.get('/params', (request_, res) => {
  res.set(
    'Content-Type',
    'text/plain; charset=utf-8; constructor=x; __proto__=y'
  );
  res.set(
    'Link',
    '<http://example.com/a>; rel="__proto__", <http://example.com/b>; rel="constructor", <http://example.com/c>; rel="next"'
  );
  res.end('ok');
});

app.get('/multibyte', (request_, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  // 200,000 three-byte characters: 600,000 bytes, 200,000 UTF-16 units
  res.end('€'.repeat(200000));
});

for (const [route, type] of [
  ['/bomb/text', 'text/plain'],
  ['/bomb/json', 'application/json'],
  ['/bomb/image', 'image/png']
]) {
  app.get(route, (request_, res) => {
    res.set('Content-Type', type);
    res.set('Content-Encoding', 'gzip');
    res.end(bomb);
  });
}

app.post('/echo-body', (request_, res) => {
  const chunks = [];
  request_.on('data', (chunk) => chunks.push(chunk));
  request_.on('end', () => {
    res.set('Content-Type', 'text/plain');
    res.end(Buffer.concat(chunks).toString());
  });
});

app.get('/unbuffered-text', (request_, res) => {
  res.set('Content-Type', 'text/plain');
  res.end('this body is streamed');
});

app.get('/uppercase-gzip', (request_, res) => {
  res.set('Content-Type', 'text/plain');
  res.set('Content-Encoding', 'GZIP');
  res.end(zlib.gzipSync('decompressed'));
});

app.get('/set-foreign-cookies', (request_, res) => {
  res.set('Set-Cookie', [
    'injected=1; Domain=localhost; Path=/',
    'suffix=1; Domain=com; Path=/',
    'own=1; Path=/'
  ]);
  res.end('ok');
});

app.get('/show-cookies', (request_, res) => {
  res.set('Content-Type', 'text/plain');
  res.end(String(request_.headers.cookie));
});

other.get('/set-own-domain-cookie', (request_, res) => {
  res.set('Set-Cookie', 'self=1; Domain=localhost; Path=/');
  res.end('ok');
});

other.get('/show-cookies', (request_, res) => {
  res.set('Content-Type', 'text/plain');
  res.end(String(request_.headers.cookie));
});

unixApp.get('/secret', (request_, res) => {
  secretHits++;
  res.send('secret from unix socket');
});

unixApp.get('/relative-redirect', (request_, res) => {
  res.redirect('/landed');
});

unixApp.get('/landed', (request_, res) => {
  res.send('landed on socket');
});

unixApp.get('/redirect-other-socket', (request_, res) => {
  res.redirect(`${otherUnixBase}/secret`);
});

otherUnixApp.get('/secret', (request_, res) => {
  secretHits++;
  res.send('secret from other unix socket');
});

describe('[security] redirects', () => {
  it('should not follow a redirect into a Unix domain socket', function (done) {
    if (process.platform === 'win32') return this.skip();
    secretHits = 0;
    request
      .get(`${base}/redirect-to`)
      .query({ to: `${unixBase}/secret` })
      .end((error) => {
        try {
          assert(error, 'expected an error');
          assert.strictEqual(error.code, 'EUNSUPPORTEDREDIRECT');
          assert.strictEqual(error.status, 302);
          assert.strictEqual(error.location, `${unixBase}/secret`);
          assert.strictEqual(secretHits, 0, 'unix socket must not be hit');
          done();
        } catch (err) {
          done(err);
        }
      });
  });

  it('should reject the promise for a redirect into a Unix domain socket', async function () {
    if (process.platform === 'win32') return this.skip();
    secretHits = 0;
    await assert.rejects(
      request.get(`${base}/redirect-to`).query({ to: `${unixBase}/secret` }),
      (error) => error.code === 'EUNSUPPORTEDREDIRECT'
    );
    assert.strictEqual(secretHits, 0);
  });

  for (const location of [
    'file:///etc/passwd',
    'ftp://example.com/',
    'data:text/plain,hi',
    'http2://example.com/'
  ]) {
    it(`should refuse a redirect to ${location.split(':')[0]}:`, (done) => {
      request
        .get(`${base}/redirect-to`)
        .query({ to: location, status: 301 })
        .end((error) => {
          try {
            assert(error, 'expected an error');
            assert.strictEqual(error.code, 'EUNSUPPORTEDREDIRECT');
            assert.strictEqual(error.status, 301);
            done();
          } catch (err) {
            done(err);
          }
        });
    });
  }

  it('should report an unparseable Location header instead of throwing', (done) => {
    request.get(`${base}/redirect-invalid`).end((error) => {
      try {
        assert(error, 'expected an error');
        assert.strictEqual(error.code, 'EINVALIDREDIRECT');
        assert.strictEqual(error.status, 302);
        assert.strictEqual(error.location, 'http://[::1');
        done();
      } catch (err) {
        done(err);
      }
    });
  });

  it('should still follow http(s) redirects', (done) => {
    request
      .get(`${base}/redirect-to`)
      .query({ to: `${otherBase}/echo-auth` })
      .end((error, res) => {
        try {
          assert.ifError(error);
          assert.strictEqual(res.status, 200);
          assert.deepStrictEqual(res.redirects, [`${otherBase}/echo-auth`]);
          done();
        } catch (err) {
          done(err);
        }
      });
  });

  it('should follow a relative redirect for a scheme-less URL', (done) => {
    request
      .get(`${base.replace(/^http:\/\//, '')}/redirect-relative`)
      .end((error, res) => {
        try {
          assert.ifError(error);
          assert.strictEqual(res.text, 'landed');
          assert.deepStrictEqual(res.redirects, [`${base}/landed`]);
          done();
        } catch (err) {
          done(err);
        }
      });
  });

  it('should follow a relative redirect within the same Unix domain socket', function (done) {
    if (process.platform === 'win32') return this.skip();
    request.get(`${unixBase}/relative-redirect`).end((error, res) => {
      try {
        assert.ifError(error);
        assert.strictEqual(res.text, 'landed on socket');
        assert.deepStrictEqual(res.redirects, [`${unixBase}/landed`]);
        done();
      } catch (err) {
        done(err);
      }
    });
  });

  it('should not follow a redirect from one Unix domain socket to another', function (done) {
    if (process.platform === 'win32') return this.skip();
    secretHits = 0;
    request.get(`${unixBase}/redirect-other-socket`).end((error) => {
      try {
        assert(error, 'expected an error');
        assert.strictEqual(error.code, 'EUNSUPPORTEDREDIRECT');
        assert.strictEqual(secretHits, 0);
        done();
      } catch (err) {
        done(err);
      }
    });
  });

  it('should not re-send auto-type credentials to another origin', (done) => {
    request
      .get(`${base}/redirect-to`)
      .query({ to: `${otherBase}/echo-auth` })
      .auth('user', 'secret', { type: 'auto' })
      .end((error, res) => {
        try {
          assert.ifError(error);
          assert.deepStrictEqual(res.body, { authorization: null });
          done();
        } catch (err) {
          done(err);
        }
      });
  });

  it('should keep auto-type credentials on a same-origin redirect', (done) => {
    request
      .get(`${base}/redirect-to`)
      .query({ to: `${base}/echo-auth` })
      .auth('user', 'secret', { type: 'auto' })
      .end((error, res) => {
        try {
          assert.ifError(error);
          assert.deepStrictEqual(res.body, {
            authorization: `Basic ${Buffer.from('user:secret').toString(
              'base64'
            )}`
          });
          done();
        } catch (err) {
          done(err);
        }
      });
  });
});

describe('[security] response metadata', () => {
  for (const type of [
    'constructor',
    'toString',
    'hasOwnProperty',
    '__proto__'
  ]) {
    it(`should treat a Content-Type of "${type}" as an unknown type`, (done) => {
      request.get(`${base}/type/${type}`).end((error, res) => {
        try {
          assert.ifError(error);
          assert.strictEqual(res.status, 200);
          assert.strictEqual(res.type, type);
          assert(Buffer.isBuffer(res.body), 'unknown types are buffered');
          assert.strictEqual(res.body.toString(), 'hello');
          done();
        } catch (err) {
          done(err);
        }
      });
    });
  }

  it('should ignore prototype keys in Content-Type parameters and Link relations', (done) => {
    request.get(`${base}/params`).end((error, res) => {
      try {
        assert.ifError(error);
        assert.strictEqual(res.charset, 'utf-8');
        assert.strictEqual(res.constructor, request.Response);
        assert.strictEqual(
          Object.getPrototypeOf(res),
          request.Response.prototype
        );
        assert.strictEqual(
          Object.prototype.hasOwnProperty.call(res, 'prototype'),
          false
        );
        assert.deepStrictEqual(res.links, { next: 'http://example.com/c' });
        assert.strictEqual(Object.getPrototypeOf(res.links), Object.prototype);
        assert.strictEqual(
          Object.prototype.hasOwnProperty.call(res.links, 'constructor'),
          false
        );
        assert.strictEqual({}.y, undefined);
        done();
      } catch (err) {
        done(err);
      }
    });
  });
});

describe('[security] response size', () => {
  it('should count multi-byte text against maxResponseSize in bytes', (done) => {
    request
      .get(`${base}/multibyte`)
      .maxResponseSize(300000)
      .end((error, res) => {
        try {
          assert(error, 'expected an error');
          assert.strictEqual(error.code, 'ETOOLARGE');
          assert.strictEqual(res, null);
          done();
        } catch (err) {
          done(err);
        }
      });
  });

  it('should still accept multi-byte text within maxResponseSize', (done) => {
    request
      .get(`${base}/multibyte`)
      .maxResponseSize(600000)
      .end((error, res) => {
        try {
          assert.ifError(error);
          assert.strictEqual(Buffer.byteLength(res.text), 600000);
          done();
        } catch (err) {
          done(err);
        }
      });
  });

  for (const route of ['/bomb/text', '/bomb/json', '/bomb/image']) {
    it(`should stop inflating a decompression bomb (${route}) once maxResponseSize is exceeded`, (done) => {
      const warnings = [];
      const { warn } = console;
      console.warn = (...args) => {
        warnings.push(args.join(' '));
      };

      let callbacks = 0;
      const started = Date.now();
      request
        .get(`${base}${route}`)
        .maxResponseSize(1024 * 1024)
        .end((error) => {
          callbacks++;
          if (callbacks > 1) return;
          // give any late decompressed chunks a chance to surface
          setTimeout(() => {
            console.warn = warn;
            try {
              assert(error, 'expected an error');
              assert.strictEqual(error.code, 'ETOOLARGE');
              assert.strictEqual(callbacks, 1, 'callback must fire once');
              assert.deepStrictEqual(
                warnings.filter((line) => /double callback/.test(line)),
                []
              );
              assert(
                Date.now() - started < 3000,
                'the bomb must not be inflated in full'
              );
              done();
            } catch (err) {
              done(err);
            }
          }, 250);
        });
    });
  }
});

describe('[security] request body', () => {
  it('should send an own __proto__ key verbatim instead of re-parenting the payload', (done) => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    request
      .post(`${base}/echo-body`)
      .send({ b: 2 })
      .send(payload)
      .end((error, res) => {
        try {
          assert.ifError(error);
          assert.strictEqual(
            res.text,
            '{"b":2,"__proto__":{"polluted":true},"a":1}'
          );
          assert.strictEqual({}.polluted, undefined);
          done();
        } catch (err) {
          done(err);
        }
      });
  });
});

describe('[security] unbuffered responses', () => {
  it('should not accumulate an unbuffered body while still streaming it', (done) => {
    request
      .get(`${base}/unbuffered-text`)
      .buffer(false)
      .end((error, res) => {
        try {
          assert.ifError(error);
          assert.strictEqual(res.buffered, false);
          assert.strictEqual(res.text, undefined);
        } catch (err) {
          return done(err);
        }

        let body = '';
        let chunkType;
        res.on('data', (chunk) => {
          chunkType = typeof chunk;
          body += chunk;
        });
        res.on('end', () => {
          try {
            assert.strictEqual(body, 'this body is streamed');
            // the built-in text parser's encoding is preserved for consumers
            assert.strictEqual(chunkType, 'string');
            // but nothing was collected behind the caller's back
            assert.strictEqual(res.res.text, undefined);
            done();
          } catch (err) {
            done(err);
          }
        });
      });
  });

  it('should still run a custom parser for an unbuffered response', (done) => {
    let parsed = false;
    request
      .get(`${base}/unbuffered-text`)
      .buffer(false)
      .parse((res, fn) => {
        parsed = true;
        res.on('end', () => fn(null, 'custom'));
      })
      .end((error, res) => {
        try {
          assert.ifError(error);
          assert.strictEqual(parsed, true);
          res.resume();
          done();
        } catch (err) {
          done(err);
        }
      });
  });
});

describe('[security] content-encoding', () => {
  it('should decompress a case-insensitive content-coding token', (done) => {
    request.get(`${base}/uppercase-gzip`).end((error, res) => {
      try {
        assert.ifError(error);
        assert.strictEqual(res.text, 'decompressed');
        done();
      } catch (err) {
        done(err);
      }
    });
  });
});

describe('[security] agent cookies', () => {
  it('should not store cookies a host sets for a domain it does not match', (done) => {
    const agent = request.agent();
    agent.get(`${base}/set-foreign-cookies`).end((error) => {
      if (error) return done(error);
      agent.get(`${otherBase}/show-cookies`).end((error, res) => {
        if (error) return done(error);
        try {
          assert.strictEqual(res.text, 'undefined');
        } catch (err) {
          return done(err);
        }

        agent.get(`${base}/show-cookies`).end((error, res) => {
          try {
            assert.ifError(error);
            assert.strictEqual(res.text, 'own=1');
            done();
          } catch (err) {
            done(err);
          }
        });
      });
    });
  });

  it('should keep a cookie whose Domain attribute is the host itself', (done) => {
    const agent = request.agent();
    agent.get(`${otherBase}/set-own-domain-cookie`).end((error) => {
      if (error) return done(error);
      agent.get(`${otherBase}/show-cookies`).end((error, res) => {
        try {
          assert.ifError(error);
          assert.strictEqual(res.text, 'self=1');
          done();
        } catch (err) {
          done(err);
        }
      });
    });
  });
});
