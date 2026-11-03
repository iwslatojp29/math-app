(function (root) {
  'use strict';

  function validMonth(value) {
    return typeof value === 'string' && /^[1-9]\d{3}(?:0[1-9]|1[0-2])$/.test(value);
  }

  function issueMonth(value) {
    if (typeof value !== 'string') return '';
    const text = value.normalize('NFKC');
    // Prefer an explicit Japanese issue date, wherever it occurs in the name.
    const patterns = [
      /(?:^|[^\d])([1-9]\d{3})\s*年\s*(\d{1,2})\s*月/g,
      /(?:^|[^\d])([1-9]\d{3})[._\/-](\d{1,2})(?=$|[^\d])/g,
      /(?:^|[^\d])([1-9]\d{3})(0[1-9]|1[0-2])(?=$|[^\d])/g,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const month = match[1] + match[2].padStart(2, '0');
        if (validMonth(month)) return month;
      }
    }
    return '';
  }

  function monthLabel(month) {
    return validMonth(month) ? `${Number(month.slice(0, 4))}年${Number(month.slice(4))}月` : '年月なし';
  }

  root.MathAppMaterialMetadata = Object.freeze({ issueMonth, validMonth, monthLabel });
})(globalThis);
