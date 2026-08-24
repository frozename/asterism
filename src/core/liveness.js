const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

// Ctime shape: "Www Mmm dd hh:mm:ss yyyy" -- the day is always two characters,
// either two digits or a leading space plus one digit. The weekday token is
// checked only for shape (three letters); its value is never consulted.
const CTIME_PATTERN = /^[A-Za-z]{3} ([A-Za-z]{3}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/** @param {string} str @param {{ utc?: boolean }} [options] */
export function parseCtime(str, { utc } = {}) {
  if (typeof utc !== 'boolean') {
    throw new TypeError('parseCtime: options.utc must be a boolean');
  }
  if (typeof str !== 'string') {
    throw new RangeError('parseCtime: input must be a string');
  }

  const match = CTIME_PATTERN.exec(str);
  if (match === null) {
    throw new RangeError(`parseCtime: input does not match the ctime shape: "${str}"`);
  }

  const [, monthToken, dayToken, hourToken, minuteToken, secondToken, yearToken] = match;
  const month = MONTHS.indexOf(monthToken);
  if (month === -1) {
    throw new RangeError(`parseCtime: unknown month "${monthToken}"`);
  }

  const day = Number(dayToken.trim());
  const hour = Number(hourToken);
  const minute = Number(minuteToken);
  const second = Number(secondToken);
  const year = Number(yearToken);

  if (day < 1 || day > 31) throw new RangeError(`parseCtime: day out of range: ${day}`);
  if (hour > 23) throw new RangeError(`parseCtime: hour out of range: ${hour}`);
  if (minute > 59) throw new RangeError(`parseCtime: minute out of range: ${minute}`);
  if (second > 59) throw new RangeError(`parseCtime: second out of range: ${second}`);

  const epochMs = utc
    ? Date.UTC(year, month, day, hour, minute, second)
    : new Date(year, month, day, hour, minute, second).getTime();

  return Math.round(epochMs / 1000);
}

export function isLive({ pidAlive, procStartEpoch, observedStartEpoch }) {
  if (typeof pidAlive !== 'boolean') {
    throw new TypeError('isLive: pidAlive must be a boolean');
  }
  if (!Number.isFinite(procStartEpoch) || !Number.isFinite(observedStartEpoch)) {
    throw new TypeError('isLive: procStartEpoch and observedStartEpoch must be finite numbers');
  }

  return pidAlive && Math.abs(procStartEpoch - observedStartEpoch) <= 1;
}
