/** POSIX shell 单引号转义：'it'\''s' */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
