module.exports = function (res, fn) {
  res.text = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    res.text += chunk;
  });
  res.on('end', () => {
    let body;
    let error;
    try {
      const text = res.text && res.text.replace(/^\uFEFF/, '');
      body = text && JSON.parse(text);
    } catch (err) {
      error = err;
      // issue #675: return the raw response if the response parsing fails
      error.rawResponse = res.text || null;
      // issue #876: return the http status code if the response parsing fails
      error.statusCode = res.statusCode;
      // issue #1529: preserve the standard SuperAgent status property as well
      error.status = res.statusCode;
      // issue #1734: return the response headers if the response parsing fails
      error.headers = res.headers;
    } finally {
      fn(error, body);
    }
  });
};
