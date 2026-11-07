// Shared teaching components copied verbatim from the original SAPIX lessons.
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SapixTeachingTools=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function ladder(rows){
  var cols = rows[0].n.length, cw = 50, rh = 32, x0 = 48;
  var W = x0 + 14 + cols * cw + 6, H = rows.length * rh + 12;
  var s = '<svg class="figsvg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="すだれ算" style="width:' + Math.round(W * 1.15) + 'px;max-width:100%;height:auto;display:block;margin:6px 0">';
  rows.forEach(function(r, i){
    var y = 26 + i * rh;
    if (r.d !== undefined && r.d !== null) {
      s += '<text class="' + (r.part ? 'ann2' : 'ann') + '" x="' + (x0 - 10) + '" y="' + y + '" text-anchor="end">' + r.d + '</text>';
      s += '<path class="edge" d="M' + (x0 - 2) + ' ' + (y - 21) + ' Q' + (x0 + 8) + ' ' + (y - 8) + ' ' + (x0 - 2) + ' ' + (y + 7) + ' H' + (W - 4) + '"/>';
    }
    r.n.forEach(function(v, j){
      var keep = (v !== null && typeof v === 'object');
      s += '<text' + (keep ? ' class="ann2"' : '') + ' x="' + (x0 + 14 + j * cw + cw / 2) + '" y="' + y + '" text-anchor="middle">' + (keep ? v.v : v) + '</text>';
    });
  });
  return s + '</svg>';
}
function vcalc(rows, label){
  var cw = 20, dw = 8, rh = 28, x0 = 34, n = 0;
  function width(str, shift){ var w = (shift || 0) * cw; for (var i = 0; i < str.length; i++) w += (str.charAt(i) === '.' ? dw : cw); return w; }
  rows.forEach(function(r){ var w = width(r.s, r.shift); if (w > n) n = w; });
  var right = x0 + n, W = right + 10, H = 12 + rows.length * rh + 6;
  var s = '<svg class="figsvg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + (label || '筆算') + '">';
  rows.forEach(function(r, i){
    var y = 12 + (i + 1) * rh - 8, x = right - (r.shift || 0) * cw;
    for (var k = r.s.length - 1; k >= 0; k--){
      var ch = r.s.charAt(k), w = (ch === '.' ? dw : cw);
      s += '<text' + (r.cls ? ' class="' + r.cls + '"' : '') + ' x="' + (x - w / 2) + '" y="' + y + '" text-anchor="middle">' + ch + '</text>';
      x -= w;
    }
    if (r.op) s += '<text x="' + (x0 - 14) + '" y="' + y + '" text-anchor="middle">' + r.op + '</text>';
    if (r.line) s += '<line class="edge" x1="' + (x0 - 26) + '" y1="' + (y + 7) + '" x2="' + (right + 4) + '" y2="' + (y + 7) + '"/>';
  });
  return s + '</svg>';
}
return {ladder:ladder,vcalc:vcalc};
});
