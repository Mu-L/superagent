'use strict';

const assert = require('node:assert');
const http = require('node:http');
const request = require('../support/client');

const isHttp2 = Boolean(process.env.HTTP2_TEST);

function countClientSockets() {
  if (typeof process.getActiveResourcesInfo !== 'function') {
    return null;
  }

  return process.getActiveResourcesInfo().filter((name) => {
    return name === 'TCPSocketWrap' || name === 'TLSWRAP';
  }).length;
}

function assertDisposed(nodeRequest) {
  assert(nodeRequest, 'expected an underlying Node request to exist');
  if (nodeRequest.session) {
    assert.equal(
      true,
      nodeRequest.destroyed || nodeRequest.session.destroyed,
      'expected HTTP/2 session to be destroyed'
    );
    return;
  }

  assert.equal(
    true,
    Boolean(nodeRequest.destroyed || nodeRequest.aborted),
    'expected request to be destroyed or aborted'
  );
}

function waitForNoNewSockets(before, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    if (before === null) {
      resolve();
      return;
    }

    const start = Date.now();
    const check = () => {
      const after = countClientSockets();
      if (after <= before) {
        resolve();
        return;
      }

      if (Date.now() - start >= timeoutMs) {
        reject(
          new Error(
            `expected no dangling TCP/TLS handle (before=${before}, after=${after})`
          )
        );
        return;
      }

      setTimeout(check, 10);
    };

    check();
  });
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}/`
      });
    });
  });
}

function endError(request_) {
  return new Promise((resolve) => {
    request_.end(resolve);
  });
}

describe('request disposal on setup errors', () => {
  let server;
  let url;

  before(async () => {
    ({ server, url } = await listen((_incoming, response) => {
      // Hold the connection so a leaked request would stay visible.
      setTimeout(() => {
        response.end('ok');
      }, 10000);
    }));
  });

  after((done) => {
    server.close(done);
  });

  describe('undefined header values', () => {
    before(function () {
      // HTTP/2's wrapper stores header values without Node's setHeader check,
      // so this particular TypeError is HTTP/1-only (see #1827).
      if (isHttp2) this.skip();
    });

    it('should pass the error to .end() and not leave a dangling request', async () => {
      const before = countClientSockets();
      const request_ = request.get(url).set({ 'x-header': undefined });
      const error = await endError(request_);

      assert(error, 'expected an error');
      assert.ok(
        /undefined/i.test(error.message),
        'expected the header TypeError'
      );
      // Invalid headers now fail before http.request() creates a socket,
      // so there may be no req to dispose.
      if (request_.req) assertDisposed(request_.req);
      await waitForNoNewSockets(before);
    });

    it('should reject the promise and not leave a dangling request', async () => {
      const before = countClientSockets();
      const request_ = request.get(url).set({ 'x-header': undefined });

      let error;
      try {
        await request_;
      } catch (err) {
        error = err;
      }

      assert(error, 'expected the promise to reject');
      assert.ok(/undefined/i.test(error.message));
      if (request_.req) assertDisposed(request_.req);
      await waitForNoNewSockets(before);
    });

    it('should still throw from .end() when no callback is given', async () => {
      const before = countClientSockets();
      const request_ = request.get(url).set({ 'x-header': undefined });

      assert.throws(() => {
        request_.end();
      }, /undefined/i);

      if (request_.req) assertDisposed(request_.req);
      await waitForNoNewSockets(before);
    });
  });

  describe('unexpected request-path errors', () => {
    it('should dispose the request when the serializer throws', async () => {
      const before = countClientSockets();
      const request_ = request
        .post(url)
        .send({ foo: 'bar' })
        .serialize(() => {
          throw new Error('serializer boom');
        });
      const error = await endError(request_);

      assert(error, 'expected an error');
      assert.equal(error.message, 'serializer boom');
      assertDisposed(request_.req);
      await waitForNoNewSockets(before);
    });
  });
});
