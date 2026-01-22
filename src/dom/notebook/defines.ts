/**
 * Notebook View Constants
 */

// Sort index length for annotations (matching snapshot view)
export const SORT_INDEX_LENGTH = 8;
export const SORT_INDEX_LENGTH_OLD = 7;

// Default cell heights
export const DEFAULT_CODE_CELL_MIN_HEIGHT = 60;
export const DEFAULT_MARKDOWN_CELL_MIN_HEIGHT = 40;

// Cell execution states
export type CellExecutionState = 'idle' | 'pending' | 'running' | 'success' | 'error';

// Supported output MIME types in order of preference
export const OUTPUT_MIME_PRIORITY = [
	'text/html',
	'image/png',
	'image/jpeg',
	'image/svg+xml',
	'text/plain',
	'application/json',
];
