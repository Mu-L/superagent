'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const request = require('../support/client');
const getSetup = require('../support/setup');

const img = fs.readFileSync(`${__dirname}/fixtures/test.png`);

describe('res.body', () => {
  let setup;
  let base;

  before(async () => {
    setup = await getSetup();
    base = setup.uri;
  });

  describe('image/png', () => {
    it('should parse the body', (done) => {
      request.get(`${base}/image`).end((error, res) => {
        res.type.should.equal('image/png');
        Buffer.isBuffer(res.body).should.be.true();
        (res.body.length - img.length).should.equal(0);
        done();
      });
    });

    it('should honor buffer(false)', (done) => {
      request
        .get(`${base}/image`)
        .buffer(false)
        .end((error, res) => {
          try {
            assert.ifError(error);
            assert.strictEqual(res.buffered, false);
            assert.deepEqual(res.body, {});
            done();
          } catch (err) {
            done(err);
          }
        });
    });

    it('should not double-callback when maxResponseSize is exceeded', (done) => {
      const warns = [];
      const { warn } = console;
      console.warn = function (...args) {
        warns.push(args.join(' '));
      };

      request
        .get(`${base}/image`)
        .maxResponseSize(1)
        .end((error) => {
          // Late parser/error events fire after the first callback.
          setImmediate(() => {
            console.warn = warn;
            try {
              assert.equal(
                error && error.message,
                'Maximum response size reached'
              );
              assert.equal(error && error.code, 'ETOOLARGE');
              assert.equal(
                warns.some((line) => /double callback/.test(line)),
                false,
                `unexpected warning(s): ${warns.join('; ')}`
              );
              done();
            } catch (err) {
              done(err);
            }
          });
        });
    });
  });
  describe('application/octet-stream', () => {
    it('should parse the body', (done) => {
      request
        .get(`${base}/image-as-octets`)
        .buffer(true) // that's tech debt :(
        .end((error, res) => {
          res.type.should.equal('application/octet-stream');
          Buffer.isBuffer(res.body).should.be.true();
          (res.body.length - img.length).should.equal(0);
          done();
        });
    });
  });
  describe('application/octet-stream', () => {
    it('should parse the body (using responseType)', (done) => {
      request
        .get(`${base}/image-as-octets`)
        .responseType('blob')
        .end((error, res) => {
          res.type.should.equal('application/octet-stream');
          Buffer.isBuffer(res.body).should.be.true();
          (res.body.length - img.length).should.equal(0);
          done();
        });
    });
  });
});
