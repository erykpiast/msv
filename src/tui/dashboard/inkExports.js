'use strict';

let _ink = null;

function setInk(ink) {
  _ink = ink;
}

function getInk() {
  if (!_ink) throw new Error('ink not loaded yet — call setInk() first');
  return _ink;
}

module.exports = { setInk, getInk };
