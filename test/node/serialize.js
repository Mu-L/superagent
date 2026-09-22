'use strict';

const assert = require('assert');
const request = require('../support/client');
const getSetup = require('../support/setup');

describe('req.serialize(fn)', () => {
  let setup;
  let base;

  before(async () => {
    setup = await getSetup();
    base = setup.uri;
  });

  it('should take precedence over default parsers', (done) => {
    request
      .post(`${base}/echo`)
      .send({ foo: 123 })
      .serialize(() => '{"bar":456}')
      .end((error, res) => {
        assert.ifError(error);
        assert.equal('{"bar":456}', res.text);
        assert.equal(456, res.body.bar);
        done();
      });
  });

  it('should serialize CSP reports as JSON', (done) => {
    request
      .post(`${base}/echo`)
      .type('application/csp-report')
      .send({ 'csp-report': { 'document-uri': 'https://example.test/' } })
      .end((error, res) => {
        try {
          assert.ifError(error);
          assert.equal(
            res.body.toString(),
            '{"csp-report":{"document-uri":"https://example.test/"}}'
          );
          done();
        } catch (err) {
          done(err);
        }
      });
  });
});
