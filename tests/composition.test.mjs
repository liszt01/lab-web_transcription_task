import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const csv = fs.readFileSync(new URL('../src/assets/data/phrase_set.csv', import.meta.url), 'utf8');

class Element {
  value = ''; hidden = false; disabled = false; textContent = '';
  selectionStart = 0; selectionEnd = 0;
  listeners = {}; children = [];
  classList = { remove() {} };
  addEventListener(type, listener) { this.listeners[type] = listener; }
  emit(type, event = {}) { this.listeners[type]?.(event); }
  replaceChildren() { this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute() {} setCustomValidity() {} reportValidity() {} blur() {}
}

async function setup(baseline = '') {
  const nodes = new Map();
  const timers = new Map();
  let timerId = 0;
  const document = {
    querySelector(id) {
      if (!nodes.has(id)) nodes.set(id, new Element());
      return nodes.get(id);
    },
    createElement() { return new Element(); },
  };
  const context = vm.createContext({
    document, performance,
    fetch: async () => ({ ok: true, text: async () => csv }),
    localStorage: { getItem() { return null; } },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  await vm.runInContext(`(async () => {
    ${source}
    globalThis.snapshot = () => ({ f: fixCount, committedChars, rows });
  })()`, context);
  const get = id => nodes.get('#' + id);
  get('participant-id').value = 'test';
  get('start-button').emit('click');
  const input = get('transcription-input');
  if (baseline) { input.value = baseline; input.emit('input'); }
  input.emit('compositionstart', { data: '' });
  return {
    get, input,
    snapshot: () => context.snapshot(),
    update(text) {
      // compositionupdate can precede the DOM change.
      input.emit('compositionupdate', { data: text });
      input.value = baseline + text;
      input.emit('input', { inputType: 'insertCompositionText', isComposing: true });
    },
    clear(inputType = 'deleteCompositionText', withUpdate = true) {
      input.emit('beforeinput', { inputType, isComposing: true });
      if (withUpdate) input.emit('compositionupdate', { data: '' });
      input.value = baseline;
      input.emit('input', { inputType, isComposing: true });
    },
    commit(text, endFirst = false, endData = text) {
      if (endFirst) input.emit('compositionend', { data: endData });
      input.value = baseline + text;
      input.emit('input', { inputType: 'insertFromComposition', isComposing: !endFirst });
      if (!endFirst) input.emit('compositionend', { data: endData });
    },
    tick() {
      while (timers.size) {
        const [id, fn] = timers.entries().next().value;
        timers.delete(id); fn();
      }
    },
  };
}

test('deleting the last provisional character records F and IF once', async () => {
  for (const end of [false, true]) {
    const app = await setup();
    app.update('あ'); app.clear();
    assert.equal(app.snapshot().f, 0, 'wait for possible IME confirmation');
    if (end) app.input.emit('compositionend', { data: '' });
    app.tick();
    assert.equal(app.snapshot().f, 1);
    app.get('action-button').emit('click');
    assert.equal(app.snapshot().rows[0].f, 1);
    assert.equal(app.snapshot().rows[0].if, 1);
  }
});

test('each backspace is counted, including the final character', async () => {
  const app = await setup();
  app.update('あい'); app.update('あ'); app.clear(); app.tick();
  assert.equal(app.snapshot().f, 2);
  app.get('action-button').emit('click');
  assert.equal(app.snapshot().rows[0].if, 2);
});

test('clear-and-commit never adds F, including different event order and converted text', async () => {
  for (const endFirst of [false, true]) {
    for (const endData of ['', '愛']) {
      const app = await setup('既存');
      app.update('あい'); app.clear(); app.commit('愛', endFirst, endData); app.tick();
      assert.equal(app.snapshot().f, 0);
      assert.equal(app.snapshot().committedChars, 3);
    }
  }
});

test('nonempty compositionend prevents counting a clear before a delayed final input', async () => {
  const app = await setup();
  app.update('あ'); app.clear(); app.input.emit('compositionend', { data: 'あ' }); app.tick();
  app.input.value = 'あ'; app.input.emit('input', { inputType: 'insertFromComposition' });
  assert.equal(app.snapshot().f, 0);
});

test('DOM-only clears are counted once, and DOM-only confirmation adds no F', async () => {
  const deleted = await setup('既存');
  deleted.update('あ'); deleted.clear('deleteCompositionText', false); deleted.tick();
  assert.equal(deleted.snapshot().f, 1);
  const committed = await setup();
  committed.update('あ'); committed.clear('deleteCompositionText', false);
  committed.commit('あ'); committed.tick();
  assert.equal(committed.snapshot().f, 0);
});

test('explicit delete events and their composition updates are not counted twice', async () => {
  const app = await setup();
  app.update('あ'); app.clear('deleteContentBackward'); app.tick();
  assert.equal(app.snapshot().f, 1);
});

test('Submit flushes a pending final-character deletion before timers run', async () => {
  const app = await setup();
  app.update('あ'); app.clear(); app.get('action-button').emit('click'); app.tick();
  assert.equal(app.snapshot().rows[0].f, 1);
  assert.equal(app.snapshot().f, 1);
  app.get('action-button').emit('click'); app.tick();
  assert.equal(app.snapshot().f, 0);
  assert.equal(app.get('action-button').disabled, true);
});

test('continued typing after a settled deletion retains F; confirmation adds none', async () => {
  const app = await setup();
  app.update('あ'); app.clear(); app.tick(); app.update('い'); app.clear(); app.commit('い'); app.tick();
  assert.equal(app.snapshot().f, 1);
});

test('no-op delete and deletion of committed text retain previous behavior', async () => {
  const app = await setup();
  app.input.emit('beforeinput', { inputType: 'deleteContentBackward', isComposing: true });
  app.update(''); app.input.emit('compositionend', { data: '' }); app.tick();
  assert.equal(app.snapshot().f, 0);
  app.input.value = 'あ'; app.input.emit('input');
  app.input.value = ''; app.input.emit('input');
  assert.equal(app.snapshot().f, 1);
});
