/** Structured details attached to an {@link ApplicationError}. */
export type ErrorContext = Readonly<Record<string, unknown>>;

/**
 * Base class for errors raised by application code.
 *
 * Subclasses inherit a name based on their class name and may attach structured
 * context and an underlying cause.
 *
 * Usage rules:
 * - Create subclasses for failures callers may handle or report differently.
 * - Include useful diagnostic details in `context`; do not put secrets there.
 * - Preserve the original error with `cause` when wrapping another failure.
 * - Catch errors at an appropriate boundary instead of catching every operation.
 *
 * @example
 * ```ts
 * class StorageError extends ApplicationError {
 *   public constructor(key: string, options?: ErrorOptions) {
 *     super(`Failed to read "${key}"`, { key }, options);
 *   }
 * }
 *
 * try {
 *   await readFromStorage(key);
 * } catch (cause) {
 *   throw new StorageError(key, { cause });
 * }
 * ```
 */
export default class ApplicationError extends Error {
  /** Additional structured details for logging or handling this error. */
  public readonly context: ErrorContext;

  /**
   * Creates an application error.
   *
   * @param message - Human-readable description of the failure.
   * @param context - Structured diagnostic details associated with the failure.
   * @param options - Standard error options, including an optional underlying cause.
   */
  protected constructor(message: string, context: ErrorContext = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.context = context;
  }
}
