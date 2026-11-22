// Node/jsdom cannot execute a browser Worker. Importing its entry must not run
// the worker body on the test thread. Tests of the diff pool inject its factory;
// actual worker execution belongs to the browser suite.
export default class BrowserWorker {
  constructor() {
    throw new Error('Browser Worker execution requires a browser test');
  }
}
