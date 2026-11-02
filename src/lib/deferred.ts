/**
 * A class that allows manual control over the resolution and rejection of a Promise.
 * This is useful when you need to create a Promise but resolve or reject it asynchronously,
 * potentially from within a callback or event handler.
 */
export default class Deferred<T, E = never> {
  public resolve: (value: T) => void;
  public reject: (reason: E) => void;
  public promise: Promise<T>;

  public constructor() {
    this.resolve = () => {};
    this.reject = () => {};
    this.promise = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}
