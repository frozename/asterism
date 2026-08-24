/**
 * @param {(text: string) => unknown} [write]
 */
export function emitNotes(notes, write = (text) => process.stderr.write(text)) {
  for (const entry of notes) {
    write(`note: ${entry.adapter}: ${entry.note}: ${entry.detail}\n`);
  }
}
