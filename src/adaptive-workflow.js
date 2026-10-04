/**
 * Compatibility facade for the canonical adaptive workflow kernel.
 *
 * Workflow selection is implemented in unified-adaptive-workflow.js. Keeping
 * this tiny facade preserves existing imports without maintaining a second
 * workflow authority.
 */
export { selectAdaptiveWorkflow } from './unified-adaptive-workflow.js';
