const metricUnits = new Map();
for (const [symbol, name] of [['mm', 'ミリメートル'], ['cm', 'センチメートル'], ['m', 'メートル'], ['km', 'キロメートル']]) {
  metricUnits.set(symbol, symbol);
  metricUnits.set(name, symbol);
  for (const [power, prefix] of [['2', '平方'], ['3', '立方']]) {
    for (const spelling of [symbol + power, symbol + '^' + power, prefix + name]) metricUnits.set(spelling, symbol + power);
  }
}

// Match complete metric units, so cm is distinct from m and from cm²/cm³.
const metricToken = /(?<![A-Za-z/])(?:(?:平方|立方)?(?:キロ|センチ|ミリ)?メートル|(?:km|cm|mm|m)(?:\^?[23])?)(?![A-Za-z0-9/^])/gu;

function containsLiteralUnit(answer, unit) {
  for (let start = answer.indexOf(unit); start !== -1; start = answer.indexOf(unit, start + 1)) {
    const before = answer[start - 1] || '', after = answer[start + unit.length] || '';
    if (!/[A-Za-z/]/u.test(before) && !/[A-Za-z0-9/^]/u.test(after)) return true;
  }
  return false;
}

export function formatAnswerText(answerText, unit) {
  const suffix = unit.trim();
  if (!suffix) return answerText;
  const normalizedAnswer = answerText.normalize('NFKC'), normalizedUnit = suffix.normalize('NFKC');
  const metric = metricUnits.get(normalizedUnit);
  const alreadyPresent = metric
    ? Array.from(normalizedAnswer.matchAll(metricToken), match => metricUnits.get(match[0])).includes(metric)
    : containsLiteralUnit(normalizedAnswer, normalizedUnit);
  return answerText + (alreadyPresent ? '' : ' ' + suffix);
}
