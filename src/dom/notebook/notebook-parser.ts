/**
 * Notebook Parser
 * Parses Jupyter Notebook (.ipynb) JSON format into a structured cell array.
 */

export interface NotebookMetadata {
	kernelspec?: {
		display_name?: string;
		language?: string;
		name?: string;
	};
	language_info?: {
		name?: string;
		version?: string;
	};
	title?: string;
}

export interface CellOutput {
	output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
	name?: string; // for stream: 'stdout' | 'stderr'
	text?: string | string[];
	data?: {
		'text/plain'?: string | string[];
		'text/html'?: string | string[];
		'image/png'?: string;
		'image/jpeg'?: string;
		'application/json'?: any;
	};
	// For error output
	ename?: string;
	evalue?: string;
	traceback?: string[];
	execution_count?: number;
}

export interface NotebookCell {
	id: string;
	cell_type: 'code' | 'markdown' | 'raw';
	source: string;
	outputs: CellOutput[];
	execution_count: number | null;
	metadata: Record<string, any>;
}

export interface ParsedNotebook {
	cells: NotebookCell[];
	metadata: NotebookMetadata;
	nbformat: number;
	nbformat_minor: number;
	language: string;
}

/**
 * Normalize source content which can be string or array of strings
 */
function normalizeSource(source: string | string[] | undefined): string {
	if (!source) return '';
	if (Array.isArray(source)) {
		return source.join('');
	}
	return source;
}

/**
 * Normalize output text which can be string or array of strings
 */
function normalizeOutputText(text: string | string[] | undefined): string {
	if (!text) return '';
	if (Array.isArray(text)) {
		return text.join('');
	}
	return text;
}

/**
 * Generate a unique ID for cells that don't have one
 */
function generateCellId(index: number): string {
	return `cell-${index}-${Date.now().toString(36)}`;
}

/**
 * Parse a Jupyter Notebook JSON into structured format
 */
export function parseNotebook(content: string | ArrayBuffer): ParsedNotebook {
	let jsonString: string;
	
	if (content instanceof ArrayBuffer) {
		jsonString = new TextDecoder('utf-8').decode(content);
	} else {
		jsonString = content;
	}

	const notebook = JSON.parse(jsonString);

	// Determine language from metadata
	const language = notebook.metadata?.kernelspec?.language
		|| notebook.metadata?.language_info?.name
		|| 'python';

	// Parse cells
	const cells: NotebookCell[] = (notebook.cells || []).map((cell: any, index: number) => {
		const outputs: CellOutput[] = [];

		// Parse outputs for code cells
		if (cell.cell_type === 'code' && Array.isArray(cell.outputs)) {
			for (const output of cell.outputs) {
				const parsedOutput: CellOutput = {
					output_type: output.output_type,
				};

				if (output.output_type === 'stream') {
					parsedOutput.name = output.name;
					parsedOutput.text = normalizeOutputText(output.text);
				}
				else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
					parsedOutput.data = {};
					if (output.data) {
						if (output.data['text/plain']) {
							parsedOutput.data['text/plain'] = normalizeOutputText(output.data['text/plain']);
						}
						if (output.data['text/html']) {
							parsedOutput.data['text/html'] = normalizeOutputText(output.data['text/html']);
						}
						if (output.data['image/png']) {
							parsedOutput.data['image/png'] = output.data['image/png'];
						}
						if (output.data['image/jpeg']) {
							parsedOutput.data['image/jpeg'] = output.data['image/jpeg'];
						}
						if (output.data['application/json']) {
							parsedOutput.data['application/json'] = output.data['application/json'];
						}
					}
					parsedOutput.execution_count = output.execution_count;
				}
				else if (output.output_type === 'error') {
					parsedOutput.ename = output.ename;
					parsedOutput.evalue = output.evalue;
					parsedOutput.traceback = output.traceback;
				}

				outputs.push(parsedOutput);
			}
		}

		return {
			id: cell.id || generateCellId(index),
			cell_type: cell.cell_type || 'code',
			source: normalizeSource(cell.source),
			outputs,
			execution_count: cell.execution_count ?? null,
			metadata: cell.metadata || {},
		};
	});

	return {
		cells,
		metadata: notebook.metadata || {},
		nbformat: notebook.nbformat || 4,
		nbformat_minor: notebook.nbformat_minor || 0,
		language,
	};
}

/**
 * Serialize a parsed notebook back to ipynb JSON format
 */
export function serializeNotebook(notebook: ParsedNotebook): string {
	const cells = notebook.cells.map(cell => {
		const serialized: any = {
			cell_type: cell.cell_type,
			source: cell.source.split('\n').map((line, i, arr) => 
				i < arr.length - 1 ? line + '\n' : line
			),
			metadata: cell.metadata,
		};

		if (cell.id) {
			serialized.id = cell.id;
		}

		if (cell.cell_type === 'code') {
			serialized.execution_count = cell.execution_count;
			serialized.outputs = cell.outputs.map(output => {
				const serializedOutput: any = {
					output_type: output.output_type,
				};

				if (output.output_type === 'stream') {
					serializedOutput.name = output.name;
					serializedOutput.text = output.text;
				}
				else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
					serializedOutput.data = output.data;
					if (output.execution_count !== undefined) {
						serializedOutput.execution_count = output.execution_count;
					}
				}
				else if (output.output_type === 'error') {
					serializedOutput.ename = output.ename;
					serializedOutput.evalue = output.evalue;
					serializedOutput.traceback = output.traceback;
				}

				return serializedOutput;
			});
		}

		return serialized;
	});

	return JSON.stringify({
		cells,
		metadata: notebook.metadata,
		nbformat: notebook.nbformat,
		nbformat_minor: notebook.nbformat_minor,
	}, null, 1);
}

/**
 * Render cell output to HTML
 */
export function renderOutputToHtml(output: CellOutput): string {
	if (output.output_type === 'stream') {
		const className = output.name === 'stderr' ? 'output-stderr' : 'output-stdout';
		return `<pre class="${className}">${escapeHtml(output.text as string)}</pre>`;
	}
	
	if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
		// Prefer HTML output, then plain text
		if (output.data?.['text/html']) {
			return `<div class="output-html">${output.data['text/html']}</div>`;
		}
		if (output.data?.['image/png']) {
			return `<img class="output-image" src="data:image/png;base64,${output.data['image/png']}" />`;
		}
		if (output.data?.['image/jpeg']) {
			return `<img class="output-image" src="data:image/jpeg;base64,${output.data['image/jpeg']}" />`;
		}
		if (output.data?.['text/plain']) {
			return `<pre class="output-text">${escapeHtml(output.data['text/plain'] as string)}</pre>`;
		}
	}
	
	if (output.output_type === 'error') {
		const traceback = output.traceback?.join('\n') || `${output.ename}: ${output.evalue}`;
		return `<pre class="output-error">${escapeHtml(traceback)}</pre>`;
	}

	return '';
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}
