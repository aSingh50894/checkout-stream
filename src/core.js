/**
 * Core CSV parsing logic, isolated from Node streams so it is testable and
 * framework-neutral. The stream wrapper in index.js is a thin shell around
 * the functions here.
 *
 * The parser is a single-character state machine. We deliberately keep it
 * character-at-a-time: CSV is small and the awkward edge cases (quote just
 * before delimiter, trailing quote then EOF) are far easier to get right
 * when the loop considers one byte at a time.
 */

const S_FIELD_START = 0; // at the beginning of a field (no chars consumed yet)
const S_UNQUOTED    = 1; // inside an unquoted field
const S_QUOTED      = 2; // inside a quoted field
const S_QUOTE       = 3; // just saw a quote inside a quoted field; ambiguous
const S_AFTER_QUOTE = 4; // just closed a quoted field with content

/**
 * Create a fresh parser state object.
 * @param {object} [opts]
 * @param {string} [opts.delimiter=',']
 * @param {string} [opts.quote='"']
 */
export function createCsvState(opts = {}) {
  const delimiter = opts.delimiter ?? ',';
  const quote     = opts.quote ?? '"';

  if (typeof delimiter !== 'string' || delimiter.length !== 1) {
    throw new TypeError('delimiter must be a single character');
  }
  if (typeof quote !== 'string' || quote.length !== 1) {
    throw new TypeError('quote must be a single character');
  }
  if (delimiter === quote) {
    throw new TypeError('delimiter and quote must differ');
  }

  return {
    delimiter,
    quote,
    state: S_FIELD_START,
    record: [],     // current record's fields
    field: '',      // current field being built
    atLineStart: true, // true until we consume a non-newline char on this line
  };
}

/**
 * Push a completed record and reset for the next one.
 * An empty line at the very start of the input or just after a newline is
 * represented as [] to preserve row count, matching spreadsheet behaviour.
 */
function emitRecord(s, out) {
  out.push(s.record);
  s.record = [];
  s.atLineStart = true;
}

/**
 * Feed a chunk of text to the parser. Returns an array of completed records
 * (each an array of field strings). Records may be empty if the caller feeds
 * in tiny pieces; the caller should simply push them downstream.
 *
 * @param {ReturnType<typeof createCsvState>} s
 * @param {string} chunk
 * @returns {string[][]}
 */
export function feed(s, chunk) {
  if (typeof chunk !== 'string') {
    throw new TypeError('chunk must be a string; set an encoding on the stream');
  }

  const out = [];
  const { delimiter, quote } = s;

  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];

    switch (s.state) {
      case S_FIELD_START: {
        // A newline here means the current line was empty (or we just finished
        // a field and are now on a new blank line). Emit [] for it.
        if (c === '\n' || c === '\r') {
          if (!s.atLineStart) {
            // Shouldn't normally happen — a newline in FIELD_START implies
            // line start — but be safe: don't emit a phantom empty record.
            s.atLineStart = true;
          } else {
            emitRecord(s, out);
          }
          // handle \r\n as a single separator
          if (c === '\r' && chunk[i + 1] === '\n') i++;
          continue;
        }
        if (c === quote) {
          s.state = S_QUOTED;
          s.atLineStart = false;
          continue;
        }
        if (c === delimiter) {
          s.record.push('');
          s.atLineStart = false;
          // stay in FIELD_START for the next field
          continue;
        }
        // ordinary char
        s.field = c;
        s.state = S_UNQUOTED;
        s.atLineStart = false;
        continue;
      }

      case S_UNQUOTED: {
        if (c === '\n' || c === '\r') {
          s.record.push(s.field);
          s.field = '';
          emitRecord(s, out);
          if (c === '\r' && chunk[i + 1] === '\n') i++;
          s.state = S_FIELD_START;
          continue;
        }
        if (c === delimiter) {
          s.record.push(s.field);
          s.field = '';
          s.state = S_FIELD_START;
          continue;
        }
        // In an unquoted field, a quote is just an ordinary character.
        // RFC 4180 says quotes are only special at field start; being strict
        // here avoids surprises like a stray quote mid-field breaking state.
        s.field += c;
        continue;
      }

      case S_QUOTED: {
        if (c === quote) {
          s.state = S_QUOTE;
          continue;
        }
        s.field += c;
        continue;
      }

      case S_QUOTE: {
        // We saw a quote while inside a quoted field. Two quotes in a row
        // are a literal escaped quote; otherwise the quote closes the field.
        if (c === quote) {
          s.field += quote;
          s.state = S_QUOTED;
          continue;
        }
        if (c === delimiter) {
          s.record.push(s.field);
          s.field = '';
          s.state = S_FIELD_START;
          continue;
        }
        if (c === '\n' || c === '\r') {
          s.record.push(s.field);
          s.field = '';
          emitRecord(s, out);
          if (c === '\r' && chunk[i + 1] === '\n') i++;
          s.state = S_FIELD_START;
          continue;
        }
        // Anything else after the closing quote: treat the field as closed
        // and the char as trailing content of an unquoted tail. This is the
        // "malformed but recoverable" case; Excel does the same.
        s.state = S_AFTER_QUOTE;
        s.field += c;
        continue;
      }

      case S_AFTER_QUOTE: {
        if (c === '\n' || c === '\r') {
          s.record.push(s.field);
          s.field = '';
          emitRecord(s, out);
          if (c === '\r' && chunk[i + 1] === '\n') i++;
          s.state = S_FIELD_START;
          continue;
        }
        if (c === delimiter) {
          s.record.push(s.field);
          s.field = '';
          s.state = S_FIELD_START;
          continue;
        }
        s.field += c;
        continue;
      }
    }
  }

  return out;
}

/**
 * Flush any pending field/record at end of input. Returns zero or one record.
 *
 * Rules:
 *  - Trailing newline already produced a record in feed(); no phantom here.
 *  - Unterminated quoted field at EOF: close it (lenient). Real CSV producers
 *    sometimes cut off; rejecting would make streams that crash mid-flight
 *    unparseable, which is worse than a slightly lossy field.
 *  - Empty input or a file ending exactly after a newline yields NO record.
 *  - A record with at least one field (even an empty field) is emitted.
 *  - A lone blank line at EOF is NOT emitted as an extra empty record.
 *
 * @param {ReturnType<typeof createCsvState>} s
 * @returns {string[][]}
 */
export function flush(s) {
  const out = [];

  // If we're at field start with an empty record and an empty field, the
  // input either was empty or ended exactly on a newline. No record.
  if (s.state === S_FIELD_START && s.record.length === 0 && s.field === '' && s.atLineStart) {
    return out;
  }

  // S_QUOTE means we saw a closing quote; treat the field as complete.
  if (s.state === S_QUOTE || s.state === S_AFTER_QUOTE) {
    s.record.push(s.field);
    s.field = '';
    out.push(s.record);
    s.record = [];
    return out;
  }

  if (s.state === S_QUOTED) {
    // Unterminated quoted field at EOF: close it leniently.
    s.record.push(s.field);
    s.field = '';
    out.push(s.record);
    s.record = [];
    return out;
  }

  if (s.state === S_UNQUOTED) {
    s.record.push(s.field);
    s.field = '';
    out.push(s.record);
    s.record = [];
    return out;
  }

  // S_FIELD_START with a non-empty record (e.g. "a,"): emit the trailing empty field.
  if (s.state === S_FIELD_START && s.record.length > 0) {
    s.record.push('');
    out.push(s.record);
    s.record = [];
    return out;
  }

  return out;
}
