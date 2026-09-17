/** The CLI's one-line stdout writer; text output has a single exit point. */
export function writeOut(value) {
  process.stdout.write(`${value}\n`);
}
