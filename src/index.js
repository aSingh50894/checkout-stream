/**
 * CSV Stream Parser — a zero-dependency Node.js Transform stream for parsing CSV.
 *
 * Exports:
 *   - CsvParser  (class, extends stream.Transform)
 *   - parseCsv   (convenience function: string -> array of string arrays)
 */

import { Transform } from 'node:stream';
import { createCsvState, feed, flush } from './core.js';

/**
 * A Transform stream that converts raw CSV bytes/strings into arrays of fields,
 * one array per parsed record (one record per emitted 'data' chunk).
 *
 * Design choices, documented up front so callers know what they are getting:
 *
 *  - Input is text. The stream expects the encoding to be set by the caller
 *    (default 'utf8'). Binary handling is out of scope.
 *  - Newlines are recognised as either \n or \r\n when they appear unquoted. A lone
 *    \r (old Mac) is treated as a record separator too.
 *  - If the final record has no trailing newline, it is still emitted on 'end'.
 *  - An empty input or a trailing newline after the last record does NOT produce
 *    an empty trailing record.
 *  - A completely empty line (no fields) is emitted as [] only when it occurs
 *    between records; two consecutive newlines therefore yield one [] record.
 *    This matches how spreadsheets treat blank rows.
 *  - Quotes are the double-quote character " by default. Inside a quoted field,
 *    two consecutive quotes are collapsed into one (RFC 4180 escaping).
 *  - A quote may appear mid-field only if the field is quoted.
 */
export class CsvParser extends Transform {
  /**
   * @param {object} [opts] - Transform options plus:
   * @param {string} [opts.delimiter=',']
   * @param {string} [opts.quote='"']
   */
  constructor(opts = {}) {
    super({ ...opts, objectMode: true });
    this._csv = createCsvState(opts);
  }

  _transform(chunk, _encoding, cb) {
    try {
      for (const record of feed(this._csv, chunk)) {
        this.push(record);
      }
      cb();
    } catch (err) {
      cb(err);
    }
  }

  _flush(cb) {
    try {
      for (const record of flush(this._csv)) {
        this.push(record);
      }
      cb();
    } catch (err) {
      cb(err);
    }
  }
}

/**
 * Convenience synchronous parser.
 *
 * @param {string} input - Complete CSV text.
   * @param {object} [opts]
   * @returns {string[][]} Array of records, each an array of field strings.
   */
export function parseCsv(input, opts) {
  const state = createCsvState(opts);
  const out = feed(state, input);
  out.push(...flush(state));
  return out;
}
