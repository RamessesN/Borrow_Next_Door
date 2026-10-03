/* Minimal DOM harness so D's UI wiring can be exercised without a browser.
   It records the delegated listeners app.js registers, and lets a test fire
   synthetic click / change / submit events with a fake target. */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'bnd-demo-v1';

function createApp(options) {
  options = options || {};
  const elements = new Map();
  const listeners = {};
  const stored = new Map(Object.entries(options.storage || {}));

  function element(selector) {
    if (!elements.has(selector)) {
      elements.set(selector, {
        innerHTML: '', textContent: '', value: '', checked: false,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute() {}, removeAttribute() {}, focus() {},
        showModal() {}, close() {}, reset() {}
      });
    }
    return elements.get(selector);
  }

  function node(props) {
    const el = Object.assign({
      id: '', dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {}, removeAttribute() {}, focus() {},
      matches: () => false,
      closest: () => el,
      reset() {}
    }, props || {});
    return el;
  }

  function fire(type, props) {
    const target = node(props);
    (listeners[type] || []).forEach(fn => fn({ target, preventDefault() {} }));
    return target;
  }

  const sandbox = {
    console,
    URL,
    FormData: class FormDataStub {
      constructor(form) { this.fields = (form && form._fields) || {}; }
      get(name) { return this.fields[name]; }
    },
    location: { hash: '#community', href: 'http://localhost:5173' },
    crypto: require('node:crypto').webcrypto,
    localStorage: {
      getItem: k => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => stored.set(k, v),
      removeItem: k => stored.delete(k)
    },
    setTimeout: () => 0,
    clearTimeout() {},
    document: {
      querySelector: element,
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); }
    },
    window: {
      BND_INTEGRATIONS: (options.integrations || {}),
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      scrollTo() {}
    }
  };
  const context = vm.createContext(sandbox);

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/task-module.js'), 'utf8'), context);
  if (!context.BND_TASK) throw new Error('web/task-module.js did not publish BND_TASK');
  context.window.BND_TASK = context.BND_TASK;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8'), context);

  return {
    run: source => vm.runInContext(source, context),
    element,
    stored,
    key: KEY,
    /** Click a button-ish target, e.g. {dataset:{borrow:'t1', req:'r1'}}. */
    click: props => fire('click', props),
    /** Toggle a checkbox, e.g. {dataset:{self:'r1'}, checked:true}. */
    change: props => fire('change', props),
    /** Submit a form, e.g. submit('#publish-form', {name, category, description}). */
    submit: (selector, fields) => fire('submit', { id: selector.replace('#', ''), _fields: fields }),
    html: () => element('#main').innerHTML
  };
}

module.exports = { createApp };
