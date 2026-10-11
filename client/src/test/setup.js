import '@testing-library/jest-dom/vitest';

// jsdom has no object-URL implementation. Document downloads create one to hand
// the authenticated blob to the browser, so the tests need a stand-in (and can
// then assert that it is released again).
if (!window.URL.createObjectURL) window.URL.createObjectURL = () => 'blob:mock';
if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};

// jsdom's File predates Blob.arrayBuffer(), which every supported browser has
// had for years. The upload path reads the selected file with it, so the test
// environment needs the same capability.
if (window.File && !window.File.prototype.arrayBuffer) {
  window.File.prototype.arrayBuffer = function arrayBuffer() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

// jsdom does not implement matchMedia; some libs probe it.
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
