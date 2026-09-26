import { readFile } from 'node:fs/promises';
const schema = JSON.parse(await readFile(new URL('../lesson.schema.json', import.meta.url), 'utf8'));

export function validateSchema(value, node = schema, location = '$') {
  if (node.$ref) return validateSchema(value, schema.$defs[node.$ref.split('/').at(-1)], location);
  if (node.anyOf) {
    for (const option of node.anyOf) { try { validateSchema(value, option, location); return; } catch {} }
    throw new Error(location + ': does not match a supported type');
  }
  const type = node.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(location + ': expected object');
    for (const key of node.required) if (!Object.hasOwn(value, key)) throw new Error(location + '.' + key + ': required');
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(node.properties, key)) throw new Error(location + ': unexpected property ' + key);
      validateSchema(value[key], node.properties[key], location + '.' + key);
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(location + ': expected array');
    value.forEach((item, index) => validateSchema(item, node.items, location + '[' + index + ']'));
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) throw new Error(location + ': expected finite ' + type);
  } else if (typeof value !== type) throw new Error(location + ': expected ' + type);
  if (node.enum && !node.enum.includes(value)) throw new Error(location + ': unsupported value');
}

function ensure(condition, message) { if (!condition) throw new Error(message); }
function unique(items, label) {
  const set = new Set();
  for (const item of items) {
    ensure(/^[A-Za-z][A-Za-z0-9_-]*$/.test(item.id), label + ': IDs must start with a letter and use letters, digits, _ or -');
    ensure(!set.has(item.id), label + ': duplicate ID ' + item.id);
    set.add(item.id);
  }
  return set;
}
function refs(values, ids, label) { for (const value of values) ensure(ids.has(value), label + ': missing reference ' + value); }
function viewBox(box, label) { ensure(box.width > 0 && box.height > 0, label + ': viewBox must have positive dimensions'); }
function primitiveDimension(condition, message, problemId, primitive, field, minimum, exclusive) {
  if (condition) return;
  // Existing repair prompts include error.message in their checkpoint key.
  // Add precise diagnostics separately so validated responses stay reusable.
  const error = new Error(message);
  error.details = { problemId, primitiveId: primitive.id, kind: primitive.kind,
    field, value: primitive[field], minimum, exclusive };
  throw error;
}

export function validateLesson(lesson) {
  validateSchema(lesson);
  ensure(lesson.title.trim() && lesson.pdfName.trim(), 'Document title and PDF name are required');
  ensure(lesson.problems.length > 0, 'No problems were generated');
  ensure(lesson.review.coverageChecked && lesson.review.mathematicsChecked && lesson.review.readingsChecked && !lesson.review.unresolvedIssues.length, 'Lesson has unresolved review requirements');
  const sections = unique(lesson.sections, 'sections');
  const images = unique(lesson.sourceImages, 'source images');
  const problems = unique(lesson.problems, 'problems');
  ensure(lesson.coverage.length === lesson.problems.length, 'Coverage must contain every problem exactly once');
  const coverageIds = new Set();
  for (const image of lesson.sourceImages) ensure(image.pdfPage > 0 && image.alt.trim() && image.assetId.trim(), 'Source image needs its PDF page, asset and description');
  for (const coverage of lesson.coverage) {
    ensure(problems.has(coverage.problemId) && !coverageIds.has(coverage.problemId), 'Invalid or duplicate coverage problem');
    coverageIds.add(coverage.problemId);
    ensure(coverage.pdfPages.length > 0 && coverage.pdfPages.every(page => page > 0), 'Coverage needs PDF page numbers');
  }
  for (const problem of lesson.problems) {
    ensure(sections.has(problem.sectionId), problem.id + ': unknown section');
    ensure(problem.sourceImageIds.length > 0, problem.id + ': original problem image is required');
    refs(problem.sourceImageIds, images, problem.id);
    ensure(problem.number.trim() && problem.goal.trim() && problem.opening.trim() && problem.givens.length, problem.id + ': missing problem conditions or opening');
    ensure(problem.verification.status === 'verified' && !problem.verification.unresolvedIssues.length, problem.id + ': unresolved mathematical or reading review');
    for (const key of ['independentCheck', 'officialAnswerCheck', 'reasoningCheck', 'readingsCheck']) ensure(problem.verification[key].trim(), problem.id + ': missing verification ' + key);
    ensure(problem.steps.length && problem.subquestions.length && problem.staticExplanation.length, problem.id + ': missing lecture, answers or static explanation');
    viewBox(problem.diagram.viewBox, problem.id);
    const primitives = unique(problem.diagram.primitives, problem.id + ' primitives');
    ensure(primitives.size > 0 && problem.diagram.description.trim(), problem.id + ': diagram and alternative description required');
    const formulas = unique(problem.formulas, problem.id + ' formulas');
    for (const formula of problem.formulas) {
      ensure(formula.parts.length && formula.description.trim(), problem.id + ': empty formula');
      for (const part of formula.parts) {
        if (part.kind === 'fraction') ensure(part.numerator.trim() && part.denominator.trim() && part.denominator !== '0', 'Invalid fraction');
        if (part.kind === 'power') ensure(part.text.trim() && part.exponent.trim(), 'Invalid power');
      }
    }
    const facts = unique(problem.facts, problem.id + ' facts');
    const visited = new Set(), visiting = new Set();
    const factMap = new Map(problem.facts.map(fact => [fact.id, fact]));
    function checkFact(id) {
      ensure(!visiting.has(id), problem.id + ': cyclic fact dependency');
      if (visited.has(id)) return;
      visiting.add(id);
      const fact = factMap.get(id);
      ensure(fact, problem.id + ': missing fact');
      for (const dependency of fact.dependencies) checkFact(dependency);
      visiting.delete(id); visited.add(id);
    }
    problem.facts.forEach(fact => checkFact(fact.id));
    unique(problem.steps, problem.id + ' steps');
    const cues = problem.steps.flatMap(step => step.cues);
    const cueIds = unique(cues, problem.id + ' cues');
    for (const step of problem.steps) { viewBox(step.viewBox, step.id); ensure(step.cues.length, 'Empty step ' + step.id); }
    for (const primitive of problem.diagram.primitives) {
      for (const key of ['radius', 'fontSize', 'scale', 'height', 'strokeWidth']) if (Object.hasOwn(primitive, key)) primitiveDimension(primitive[key] > 0, 'Invalid primitive dimension', problem.id, primitive, key, 0, true);
      if (Object.hasOwn(primitive, 'width')) primitiveDimension(primitive.width > 0, 'Invalid primitive width', problem.id, primitive, 'width', 0, true);
      if (primitive.kind === 'label') primitiveDimension(primitive.fontSize >= 14, 'Diagram labels must start at 14 SVG units or larger', problem.id, primitive, 'fontSize', 14, false);
      if (primitive.kind === 'polygon') ensure(primitive.points.length >= 3, 'Polygon needs three points');
      if (primitive.kind === 'polyline') ensure(primitive.points.length >= 2, 'Polyline needs two points');
    }
    for (const cue of cues) {
      ensure(cue.displayText.trim() && cue.speechText.trim(), cue.id + ': text and reviewed pronunciation are required');
      refs(cue.state.visibleIds, primitives, cue.id); refs(cue.state.highlightIds, new Set(cue.state.visibleIds), cue.id);
      refs(cue.formulaIds, formulas, cue.id); refs(cue.factIds, facts, cue.id);
      const transformed = new Set();
      for (const transform of cue.state.transforms) {
        ensure(primitives.has(transform.targetId) && !transformed.has(transform.targetId) && transform.scale > 0, cue.id + ': invalid transform');
        transformed.add(transform.targetId);
      }
    }
    const subs = unique(problem.subquestions, problem.id + ' subquestions');
    for (const sub of problem.subquestions) {
      refs([sub.entryCueId, ...sub.prerequisiteCueIds], cueIds, sub.id);
      ensure(sub.answerText.trim() && sub.label.trim(), sub.id + ': missing answer');
      if (sub.answerFormulaId) refs([sub.answerFormulaId], formulas, sub.id);
    }
    const coverage = lesson.coverage.find(item => item.problemId === problem.id);
    ensure(coverage.sectionId === problem.sectionId && coverage.subquestionIds.length === subs.size && new Set(coverage.subquestionIds).size === subs.size, problem.id + ': coverage differs from subquestions');
    refs(coverage.subquestionIds, subs, problem.id + ' coverage');
    for (const block of problem.staticExplanation) {
      ensure(block.text.trim(), problem.id + ': empty static explanation');
      refs(block.formulaIds, formulas, problem.id + ' static explanation');
      refs([block.sceneCueId], cueIds, problem.id + ' static scene');
    }
  }
  return lesson;
}
