// Only this trusted renderer creates markup. Lesson data supplies typed primitives and text.
export const PALETTE = Object.freeze({ ink: '#263445', muted: '#8796a5', blue: '#1768bf', orange: '#d86812', green: '#208354', red: '#c63535', purple: '#8254ad', white: '#ffffff', none: 'none' });

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function renderFormula(formula) {
  const parts = formula.parts.map(part => {
    if (part.kind === 'fraction') return '<span class="fraction"><span>' + escapeHtml(part.numerator) + '</span><span>' + escapeHtml(part.denominator) + '</span></span>';
    if (part.kind === 'power') return '<span>' + escapeHtml(part.text) + '<sup>' + escapeHtml(part.exponent) + '</sup></span>';
    return '<span>' + escapeHtml(part.text) + '</span>';
  }).join('');
  return '<div class="formula" role="math" aria-label="' + escapeHtml(formula.description) + '">' + parts + '</div>';
}

export function transformValue(transform) {
  return transform ? 'translate(' + transform.dx + ' ' + transform.dy + ') rotate(' + transform.rotation + ') scale(' + transform.scale + ')' : 'translate(0 0) rotate(0) scale(1)';
}

export function renderScene(problem, cue, viewBox, prefix) {
  const visible = new Set(cue.state.visibleIds);
  const highlighted = new Set(cue.state.highlightIds);
  const transforms = new Map(cue.state.transforms.map(transform => [transform.targetId, transform]));
  // Colons cannot appear in lesson IDs, so namespaces cannot collide with
  // primitive IDs such as "title", "arrow", or another diagram's suffix.
  const marker = prefix + ':marker';
  const titleId = prefix + ':title';
  const point = (cx, cy, radius, angle) => ({ x: cx + radius * Math.cos(angle * Math.PI / 180), y: cy + radius * Math.sin(angle * Math.PI / 180) });
  const arcPath = (cx, cy, radius, start, end) => {
    const from = point(cx, cy, radius, start), to = point(cx, cy, radius, end);
    const sweep = end - start;
    return 'M ' + from.x + ' ' + from.y + ' A ' + radius + ' ' + radius + ' 0 ' + (Math.abs(sweep) > 180 ? 1 : 0) + ' ' + (sweep >= 0 ? 1 : 0) + ' ' + to.x + ' ' + to.y;
  };
  const body = problem.diagram.primitives.filter(primitive => visible.has(primitive.id)).map(primitive => {
    const shapeId = prefix + ':target:' + primitive.id;
    const stroke = PALETTE[primitive.color || primitive.stroke];
    const fill = PALETTE[primitive.fill || 'none'];
    const width = primitive.kind === 'rect' ? primitive.strokeWidth : primitive.width || 2;
    const style = ' stroke="' + stroke + '" fill="' + fill + '" stroke-width="' + width + '" stroke-linejoin="round" stroke-linecap="round"' + (primitive.dashed ? ' stroke-dasharray="7 5"' : '');
    const arrows = (primitive.arrow === 'start' || primitive.arrow === 'both' ? ' marker-start="url(#' + marker + ')"' : '') + (primitive.arrow === 'end' || primitive.arrow === 'both' ? ' marker-end="url(#' + marker + ')"' : '');
    let shape;
    switch (primitive.kind) {
      case 'point': shape = '<circle cx="' + primitive.x + '" cy="' + primitive.y + '" r="' + primitive.radius + '" fill="' + stroke + '"/>'; break;
      case 'line': shape = '<line x1="' + primitive.x1 + '" y1="' + primitive.y1 + '" x2="' + primitive.x2 + '" y2="' + primitive.y2 + '"' + style + arrows + '/>'; break;
      case 'polyline': case 'polygon': shape = '<' + primitive.kind + ' points="' + primitive.points.map(p => p.x + ',' + p.y).join(' ') + '"' + style + arrows + '/>'; break;
      case 'rect': shape = '<rect x="' + primitive.x + '" y="' + primitive.y + '" width="' + primitive.width + '" height="' + primitive.height + '"' + style + '/>'; break;
      case 'circle': shape = '<circle cx="' + primitive.cx + '" cy="' + primitive.cy + '" r="' + primitive.radius + '"' + style + '/>'; break;
      case 'arc': shape = '<path d="' + arcPath(primitive.cx, primitive.cy, primitive.radius, primitive.startAngle, primitive.endAngle) + '"' + style + '/>'; break;
      case 'angle': {
        let d = arcPath(primitive.x, primitive.y, primitive.radius, primitive.startAngle, primitive.endAngle);
        if (primitive.rightAngle) {
          const a = point(primitive.x, primitive.y, primitive.radius, primitive.startAngle);
          const b = point(primitive.x, primitive.y, primitive.radius, primitive.endAngle);
          d = 'M ' + a.x + ' ' + a.y + ' L ' + (a.x + b.x - primitive.x) + ' ' + (a.y + b.y - primitive.y) + ' L ' + b.x + ' ' + b.y;
        }
        shape = '<path d="' + d + '"' + style + '/>'; break;
      }
      case 'label': shape = '<text x="' + primitive.x + '" y="' + primitive.y + '" fill="' + stroke + '" font-size="' + primitive.fontSize + '" data-font-size="' + primitive.fontSize + '" text-anchor="' + primitive.anchor + '" dominant-baseline="middle">' + escapeHtml(primitive.text) + '</text>'; break;
      default: throw new Error('Unsupported diagram primitive');
    }
    return '<g id="' + shapeId + '" data-target="' + escapeHtml(primitive.id) + '" class="diagram-target' + (highlighted.has(primitive.id) ? ' focused' : '') + '" transform="' + transformValue(transforms.get(primitive.id)) + '">' + shape + '</g>';
  }).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + [viewBox.x, viewBox.y, viewBox.width, viewBox.height].join(' ') + '" role="img" aria-labelledby="' + titleId + '" preserveAspectRatio="xMidYMid meet"><title id="' + titleId + '">' + escapeHtml(problem.diagram.description) + '</title><defs><marker id="' + marker + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker></defs>' + body + '</svg>';
}
