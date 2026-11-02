import util from "node:util";

const LINE_SEP = "\n";
const ANSI = {
  reset: "\u001b[0m",
  grey: "\u001b[90m",
  white: "\u001b[37m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
} as const;

function colorize(color: string, message: string) {
  return `${color}${message}${ANSI.reset}`;
}

function inspect(object: unknown) {
  return util.inspect(object, false, 2, true);
}

export default function createLogger(tag: string) {
  function _print(
    logLevel: string,
    color: (message: string) => string,
    message: string,
    ...args: unknown[]
  ) {
    const isoDateTime = new Date().toISOString();
    const date = isoDateTime.slice(0, 10);
    const time = isoDateTime.slice(11, -2);

    const n = 4;
    const type = logLevel.substring(0, n).padEnd(n);

    process.stderr.write(color(`[${type}] [${date} ${time}] [${tag}] ${message}`));
    if (args.length > 0) {
      process.stderr.write(": ");
      args.forEach((arg, i) => {
        process.stderr.write(inspect(arg));
        if (i < args.length - 1) {
          process.stderr.write(LINE_SEP);
        }
      });
    }
    process.stderr.write(LINE_SEP);
  }

  const debug = _print.bind(null, "debug", colorize.bind(null, ANSI.grey));
  const info = _print.bind(null, "info", colorize.bind(null, ANSI.white));
  const warn = _print.bind(null, "warn", colorize.bind(null, ANSI.yellow));
  const error = _print.bind(null, "error", colorize.bind(null, ANSI.red));

  return { debug, info, warn, error };
}
