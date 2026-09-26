(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SapixProblemParts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  function text(html){ return String(html || '').replace(/<[^>]*>/g, '').trim(); }
  function escape(value){ return String(value).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function normalize(label){ return text(label).replace(/（/g,'(').replace(/）/g,')').replace(/\s/g,''); }
  function matches(label, part){ var a = normalize(label), b = normalize(part); return a === b || a.startsWith(b) && /[①-⑳ア-ンあ-ん㋐-㋾]/.test(a.slice(b.length, b.length + 1)); }
  var specialAnswers = {
    '場合の数_41A-12_P16#1': [['ア'], ['イ'], ['ウ']],
    '角度_41B-02_P3#1': [['㋐'], ['㋑','㋒'], ['㋓'], ['㋔'], ['㋕']],
    '平面図形_41B-07_P20#1': [['ア','イ','ウ','エ'], ['オ','カ','キ','ク','ケ','コ','サ','シ','ス','セ']]
  };
  function answerGroup(problem, q, index){
    if (problem.id === '約数_41B-11_P15#1') return index === 0 ? problem.answers.slice(0,1) : problem.answers.slice(1);
    var explicit = specialAnswers[problem.id];
    return (problem.answers || []).filter(function(a){ return explicit ? explicit[index].indexOf(a.l) >= 0 : matches(a.l, q.l); });
  }
  function questions(problem){
    var qs = problem.questions || [];
    if (qs.length < 2 && !qs.length && problem.answers.length > 1 && problem.answers.every(function(a){ return /^\(\d+\)$/.test(normalize(a.l)); })) {
      qs = problem.answers.map(function(a){ return {l:a.l, t:'図の ' + escape(a.l) + ' に答えましょう。'}; });
    }
    if (qs.length < 2) return [];
    var out = [];
    qs.forEach(function(q, index){
      var answers = answerGroup(problem, q, index);
      var nested = answers.length > 1 && answers.every(function(a){ return normalize(a.l).startsWith(normalize(q.l)) && /^[①-⑳]$/.test(normalize(a.l).slice(normalize(q.l).length)); });
      var rows = q.t.split(/<br\s*\/?\s*>/i), intro = rows.shift();
      if (nested && rows.length === answers.length && answers.every(function(a, i){ return text(rows[i]).startsWith(normalize(a.l).slice(-1)); })) {
        answers.forEach(function(a, i){ out.push({l:a.l, t:intro + '<br>' + rows[i], answers:[a], section:q.l, nested:normalize(a.l).slice(-1)}); });
      } else out.push({l:q.l, t:q.t, answers:answers, section:q.l});
    });
    // Never drop an answer or silently attach it to the wrong subquestion.
    var used = out.flatMap(function(q){ return q.answers; });
    if (out.some(function(q){ return !q.answers.length; }) || used.length !== problem.answers.length || problem.answers.some(function(a){ return used.filter(function(b){ return a === b; }).length !== 1; })) return [];
    return out;
  }
  function explanation(problem, q){
    var original = problem.expl || '', headings = [...original.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)];
    var selected = '', common = '';
    function tablePart(section){
      return section.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi, function(row){
        var cell = row.match(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/i);
        var label = cell && text(cell[1]);
        return label && /^(\(\d+\)|（\d+）|[①-⑳])$/.test(label) && normalize(label) !== normalize(q.section) ? '' : row;
      });
    }
    headings.forEach(function(h, i){
      var section = original.slice(h.index, i + 1 < headings.length ? headings[i + 1].index : original.length);
      var label = text(h[1]), range = normalize(label).match(/^\((\d+)\)[〜～~－-]\((\d+)\)/);
      var number = normalize(q.section).match(/^\((\d+)\)$/);
      var numbered = label.match(/^(\(\d+\)|（\d+）|[①-⑳])(?:[①-⑳])?/);
      if (range) {
        if (number && +number[1] >= +range[1] && +number[1] <= +range[2]) selected += tablePart(section).replace(h[0], '<h3>' + escape(q.l) + ' 計算の確認</h3>');
      } else if (numbered && normalize(numbered[0]) === normalize(q.section)) selected += tablePart(section);
      else if (!numbered && !/答え|解答/.test(label)) common += tablePart(section);
    });
    if (selected && q.nested) {
      var introEnd = selected.indexOf('<ol'), intro = introEnd >= 0 ? selected.slice(0, introEnd) : '';
      var lis = [...selected.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)].filter(function(m){ return text(m[0]).startsWith(q.nested); });
      selected = lis.length === 1 ? intro + '<ol>' + lis[0][0] + '</ol>' : '';
    }
    // Keep complete diagrams and shared reasoning available without exposing all sibling answers by default.
    var full = '<details class="part-explanation"><summary>問題全体の解説を見る（ほかの小問の答えも含みます）</summary>' + original + '</details>';
    return (selected ? selected + common : common || '<p>この小問の答えは上に表示しています。共通の考え方・図は下の解説で確認できます。</p>') + full;
  }
  function split(problems){
    var result = [], firstByParent = Object.create(null), seen = new Set(problems.map(function(p){ return p.id; }));
    problems.forEach(function(p){
      if (p.parentId) { result.push(p); return; }
      var parts = questions(p);
      if (!parts.length || parts.some(function(q){ return (p.id + '::part:' + normalize(q.l)).length > 200; })) { result.push(p); return; }
      parts.forEach(function(q){
        var id = p.id + '::part:' + normalize(q.l);
        if (seen.has(id)) throw new Error('Duplicate problem part ID');
        seen.add(id);
        var child = Object.assign({}, p, {
          id:id, parentId:p.id, parentNo:p.no, partLabel:q.l, no:String(p.no) + q.l,
          title:p.title + ' ' + q.l, questions:[{l:q.l,t:q.t}], answers:q.answers.slice(), expl:explanation(p,q),
          contextQuestions:(p.questions || parts).map(function(part){ return {l:part.l,t:part.t}; })
        });
        if (p.after && /<table\b/i.test(p.after)) {
          var firstRow = p.after.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
          var headers = firstRow ? [...firstRow[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)] : [];
          var column = headers.findIndex(function(h){ return normalize(h[1]) === normalize(q.l); });
          if (column > 0) child.after = p.after.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, function(row, cells){
            var entries = [...cells.matchAll(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi)];
            return entries.length === headers.length ? '<tr>' + entries[0][0] + entries[column][0] + '</tr>' : row;
          });
        }
        if (p.prev) child.prev = p.prev.filter(function(a){ return q.answers.some(function(b){ return normalize(a.l) === normalize(b.l); }); });
        result.push(child); if (!firstByParent[p.id]) firstByParent[p.id] = id;
      });
    });
    return {problems:result, firstByParent:firstByParent};
  }
  return {split:split, questions:questions};
});
