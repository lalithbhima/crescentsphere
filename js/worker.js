import { averageVisibility } from './shadow.js';
self.onmessage = (ev) => {
  const { h, n, cell, hmax, flat, sunDirs, earthDirs, stride } = ev.data;
  const res = averageVisibility({ h, n, cell, hmax, flat }, sunDirs, earthDirs, stride, (p) => self.postMessage({ progress: p }));
  self.postMessage({ done: true, ...res }, [res.sun.buffer, res.earth.buffer, res.both.buffer]);
};
