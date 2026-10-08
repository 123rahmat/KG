/**
 * Pure, intentionally small visual flow grammar.
 * A fenced "flow" answer renders only a LINEAR sequence of steps:
 *
 *   Request -> Inspect files -> Edit -> Verify
 *
 * A line-per-step representation is also accepted. Graphs with branches,
 * custom directives and arbitrary SVG/HTML remain code (no unsafe guessing).
 */
export function parseFlowDiagram(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1600) return null;
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 12 || lines.some(line => /^(?:graph|flowchart|sequenceDiagram|classDiagram|digraph|subgraph|%%|---)/i.test(line))) return null;
  // Only syntax delimiters may contain an angle bracket: a valid '->'
  // must not be rejected as HTML, while markup or other syntax remains code.
  if (lines.some(line => /[<>{}[\]|]/.test(line.replaceAll('->', '').replaceAll('→', '')))) return null;
  const hasArrow = lines.some(line => line.includes('->') || line.includes('→'));
  if (hasArrow && lines.length !== 1) return null;
  const nodes = hasArrow
    ? lines[0].split(/\s*(?:->|→)\s*/)
    : lines;
  if (nodes.length < 2 || nodes.length > 9
      || nodes.some(node => !node || node.length > 110
        || /^\s*[-:>]/.test(node) || /\s{3,}/.test(node))) return null;
  if (!hasArrow && lines.some(line => /-->|==>|-\s*>/.test(line))) return null;
  return Object.freeze(nodes.map(node => node.trim()));
}
