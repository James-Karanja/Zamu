// GSM 03.38: the alphabet an SMS can carry without falling back to UCS-2 and a 70-character limit.
// The basic alphabet, plus the extension set, whose members cost two septets each.
const GSM7_BASIC =
  '@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9 !"#\u00a4%&\'()*+,-./0123456789:;<=>?' +
  '\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0';
const GSM7_EXTENDED = '^{}\\[~]|\u20ac';

/** Septets an SMS body costs: extension characters count double. */
export function septetLength(body: string): number {
  return [...body].reduce((total, char) => total + (GSM7_EXTENDED.includes(char) ? 2 : 1), 0);
}

export function nonGsmCharacters(body: string): string[] {
  return [...new Set([...body].filter((char) => !GSM7_BASIC.includes(char) && !GSM7_EXTENDED.includes(char)))];
}

