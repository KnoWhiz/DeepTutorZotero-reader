/**
 * NotebookView
 * Renders Jupyter Notebook (.ipynb) files with interactive code execution.
 */

import {
	AnnotationType,
	WADMAnnotation,
	FindState,
	NavLocation,
	NewAnnotation,
	ViewStats,
	OutlineItem
} from "../../common/types";
import {
	getBoundingPageRect,
	getInnerText,
} from "../common/lib/range";
import {
	CssSelector,
	textPositionFromRange,
	Selector,
	textPositionToRange,
	TextPositionSelector
} from "../common/lib/selector";
import DOMView, {
	DOMViewState,
	NavigateOptions
} from "../common/dom-view";
import { getUniqueSelectorContaining } from "../common/lib/unique-selector";
import {
	getVisibleTextNodes,
} from "../common/lib/nodes";
import DefaultFindProcessor, { createSearchContext } from "../common/lib/find";
import injectCSS from './stylesheets/inject.scss';
import { scrollIntoView } from "../common/lib/scroll-into-view";
import { SORT_INDEX_LENGTH } from "./defines";
import { parseNotebook, ParsedNotebook, NotebookCell, CellOutput, renderOutputToHtml } from "./notebook-parser";

// Markdown-it for rendering markdown cells
const MarkdownIt = require('markdown-it');
const md = new MarkdownIt({
	html: true,
	linkify: true,
	typographer: true,
	breaks: true
});

interface CellState {
	id: string;
	executionState: 'idle' | 'pending' | 'running' | 'success' | 'error';
	output: string;
	isEditing: boolean;
	source: string;
}

class NotebookView extends DOMView<NotebookViewState, NotebookViewData> {
	protected _find: DefaultFindProcessor | null = null;

	// These fields are initialized in _getSrcDoc() to avoid timing issues
	// with parent constructor calling _getSrcDoc before class field initializers run
	private _notebook!: ParsedNotebook | null;
	private _cellStates!: Map<string, CellState>;
	private _activeCellId!: string | null;

	private get _searchContext() {
		let searchContext = createSearchContext(getVisibleTextNodes(this._iframeDocument.body));
		Object.defineProperty(this, '_searchContext', { value: searchContext });
		return searchContext;
	}

	protected async _getSrcDoc(): Promise<string> {
		console.log('[NotebookView._getSrcDoc] START - generating notebook HTML');
		
		// Initialize fields here - must be done before class field initializers run
		// (parent constructor calls this method before our field initializers execute)
		this._cellStates = new Map();
		this._notebook = null;
		this._activeCellId = null;
		
		console.log('[NotebookView._getSrcDoc] data available:', {
			hasBuf: !!this._options.data.buf,
			hasContent: !!this._options.data.content
		});
		
		// Parse the notebook data
		if (this._options.data.buf) {
			console.log('[NotebookView._getSrcDoc] Parsing from buffer');
			this._notebook = parseNotebook(this._options.data.buf);
		} else if (this._options.data.content) {
			console.log('[NotebookView._getSrcDoc] Parsing from content');
			this._notebook = parseNotebook(this._options.data.content);
		} else {
			console.error('[NotebookView._getSrcDoc] No data available!');
			throw new Error('Notebook data (buf or content) is required');
		}
		console.log('[NotebookView._getSrcDoc] Notebook parsed:', {
			cellCount: this._notebook?.cells?.length,
			metadata: this._notebook?.metadata
		});

		// Initialize cell states
		console.log('[NotebookView._getSrcDoc] Initializing cell states for', this._notebook.cells.length, 'cells');
		for (const cell of this._notebook.cells) {
			console.log('[NotebookView._getSrcDoc] Adding cell state for ID:', cell.id, 'type:', cell.cell_type);
			this._cellStates.set(cell.id, {
				id: cell.id,
				executionState: 'idle',
				output: this._renderCellOutputs(cell.outputs),
				isEditing: false,
				source: cell.source,
			});
		}
		console.log('[NotebookView._getSrcDoc] Cell states map size:', this._cellStates.size);
		console.log('[NotebookView._getSrcDoc] Cell IDs in map:', Array.from(this._cellStates.keys()).slice(0, 10));

		// Generate the HTML document
		return this._generateNotebookHtml();
	}

	private _generateNotebookHtml(): string {
		if (!this._notebook) return '';

		const cells = this._notebook.cells.map(cell => this._renderCell(cell)).join('\n');
		const title = (this._notebook.metadata as any)?.title || 'Untitled Notebook';
		const language = this._notebook.language;

		return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="${this._getCSP()}">
	<title>${this._escapeHtml(title)}</title>
</head>
<body>
	<div class="notebook-container">
		<div class="notebook-header">
			<h1 class="notebook-title">${this._escapeHtml(title)}</h1>
			<div class="notebook-metadata">
				<span>Language: ${language}</span>
			</div>
		</div>
		<div class="notebook-cells" data-notebook-language="${language}">
			${cells}
		</div>
	</div>
</body>
</html>`;
	}

	private _renderCell(cell: NotebookCell): string {
		const state = this._cellStates.get(cell.id);
		const executionCount = cell.execution_count !== null ? `[${cell.execution_count}]` : '[ ]';

		if (cell.cell_type === 'code') {
			return this._renderCodeCell(cell, executionCount, state);
		} else if (cell.cell_type === 'markdown') {
			return this._renderMarkdownCell(cell);
		} else {
			return this._renderRawCell(cell);
		}
	}

	private _renderCodeCell(cell: NotebookCell, executionCount: string, state?: CellState): string {
		const outputHtml = state?.output || this._renderCellOutputs(cell.outputs);
		const sourceEscaped = this._escapeHtml(cell.source);

		return `
<div class="notebook-cell cell-code" data-cell-id="${cell.id}" data-cell-type="code">
	<div class="cell-header">
		<span class="cell-execution-count">${executionCount}</span>
		<span class="cell-type-indicator">Code</span>
		<div class="cell-actions">
			<button class="cell-run-button" data-action="run" data-cell-id="${cell.id}">
				<svg class="run-icon" viewBox="0 0 24 24" fill="currentColor">
					<path d="M8 5v14l11-7z"/>
				</svg>
				Run
			</button>
		</div>
	</div>
	<div class="cell-code-content">
		<textarea class="code-input" data-cell-id="${cell.id}" spellcheck="false">${sourceEscaped}</textarea>
	</div>
	<div class="cell-output" data-cell-id="${cell.id}">
		${outputHtml}
	</div>
</div>`;
	}

	private _renderMarkdownCell(cell: NotebookCell): string {
		// Render markdown to HTML
		const renderedContent = md.render(cell.source);

		return `
<div class="notebook-cell cell-markdown" data-cell-id="${cell.id}" data-cell-type="markdown">
	<div class="cell-markdown-content" contenteditable="true" data-cell-id="${cell.id}" data-raw-source="${this._escapeAttr(cell.source)}">
		${renderedContent}
	</div>
</div>`;
	}

	private _renderRawCell(cell: NotebookCell): string {
		return `
<div class="notebook-cell cell-raw" data-cell-id="${cell.id}" data-cell-type="raw">
	<div class="cell-header">
		<span class="cell-type-indicator">Raw</span>
	</div>
	<div class="cell-raw-content" contenteditable="true" data-cell-id="${cell.id}">
		${this._escapeHtml(cell.source)}
	</div>
</div>`;
	}

	private _renderCellOutputs(outputs: CellOutput[]): string {
		if (!outputs || outputs.length === 0) return '';

		const outputsHtml = outputs.map(output => renderOutputToHtml(output)).join('');
		
		return `
<div class="output-header">
	<span>Output</span>
	<button class="output-close-button" data-action="clear-output">&times;</button>
</div>
<div class="output-content">${outputsHtml}</div>`;
	}

	private _escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}

	private _escapeAttr(text: string): string {
		return encodeURIComponent(text);
	}

	getData(): NotebookViewData {
		return {
			content: this._notebook ? JSON.stringify(this._notebook) : undefined,
		};
	}

	protected override _handleIFrameLoaded() {
		return super._handleIFrameLoaded();
	}

	protected override async _handleViewCreated(viewState: Partial<Readonly<NotebookViewState>>) {
		await super._handleViewCreated(viewState);

		// Inject styles
		let style = this._iframeDocument.createElement('style');
		style.innerHTML = injectCSS;
		this._iframeDocument.head.append(style);

		// Setup cell interactions (Run buttons, editing, etc.)
		this._setupCellInteractions();

		// Update annotation overlay size
		this._updateAnnotationOverlaySize();

		// Setup resize observer
		const resizeObserver = new ResizeObserver(() => {
			this._updateAnnotationOverlaySize();
		});
		resizeObserver.observe(this._iframeDocument.body);
		this._iframeWindow.addEventListener('resize', () => {
			this._updateAnnotationOverlaySize();
		});

		// Set initial scale
		this._setScale(viewState.scale ?? 1);

		// Navigate to location if provided
		if (this._options.location) {
			this.navigate(this._options.location, { behavior: 'instant' });
		} else if (viewState.scrollYPercent !== undefined) {
			this._iframeWindow.scrollTo({
				top: viewState.scrollYPercent / 100 * (this._iframeDocument.body.scrollHeight - this._iframeDocument.documentElement.clientHeight)
			});
		}
	}

	private _setupCellInteractions() {
		console.log('[NotebookView._setupCellInteractions] Setting up cell interactions');
		
		// Handle Run button clicks
		this._iframeDocument.addEventListener('click', (e) => {
			const target = e.target as HTMLElement;
			console.log('[NotebookView] Click detected on:', target.tagName, target.className);
			
			// Run button
			const runButton = target.closest('[data-action="run"]') as HTMLElement;
			console.log('[NotebookView] Run button found:', runButton);
			if (runButton) {
				const cellId = runButton.dataset.cellId;
				console.log('[NotebookView] Run clicked for cell:', cellId);
				if (cellId) {
					this._executeCell(cellId);
				}
				return;
			}

			// Clear output button
			const clearButton = target.closest('[data-action="clear-output"]') as HTMLElement;
			if (clearButton) {
				const cell = clearButton.closest('.notebook-cell') as HTMLElement;
				if (cell) {
					const outputDiv = cell.querySelector('.cell-output') as HTMLElement;
					if (outputDiv) {
						outputDiv.innerHTML = '';
					}
				}
				return;
			}

			// Cell focus handling
			const cell = target.closest('.notebook-cell') as HTMLElement;
			if (cell) {
				this._setActiveCell(cell.dataset.cellId || null);
			}
		});

		// Handle textarea changes for code cells
		this._iframeDocument.addEventListener('input', (e) => {
			const target = e.target as HTMLElement;
			
			if (target.classList.contains('code-input')) {
				const textarea = target as HTMLTextAreaElement;
				const cellId = textarea.dataset.cellId;
				if (cellId) {
					const state = this._cellStates.get(cellId);
					if (state) {
						state.source = textarea.value;
					}
				}
				// Auto-resize the textarea
				this._autoResizeTextarea(textarea);
			}
		});

		// Auto-resize all code textareas on initial load
		const allTextareas = this._iframeDocument.querySelectorAll('.code-input') as NodeListOf<HTMLTextAreaElement>;
		allTextareas.forEach(textarea => this._autoResizeTextarea(textarea));

		// Shift+Enter to run cell - note: editing key handling is in _handleKeyDown override
		this._iframeDocument.addEventListener('keydown', (e) => {
			if (e.shiftKey && e.key === 'Enter') {
				const activeCell = this._iframeDocument.querySelector('.notebook-cell.cell-focused');
				if (activeCell) {
					const cellId = (activeCell as HTMLElement).dataset.cellId;
					if (cellId) {
						e.preventDefault();
						e.stopPropagation();
						this._executeCell(cellId);
					}
				}
			}
		}, true); // Use capture phase
	}

	private _autoResizeTextarea(textarea: HTMLTextAreaElement) {
		// Reset height to auto to get the correct scrollHeight
		textarea.style.height = 'auto';
		// Set height to scrollHeight (content height)
		// Add a small buffer (2px) to prevent scrollbar flickering
		textarea.style.height = `${textarea.scrollHeight + 2}px`;
	}

	private _setActiveCell(cellId: string | null) {
		// Remove focus from all cells
		const allCells = this._iframeDocument.querySelectorAll('.notebook-cell');
		allCells.forEach(cell => cell.classList.remove('cell-focused'));

		// Set focus on the active cell
		if (cellId) {
			const activeCell = this._iframeDocument.querySelector(`[data-cell-id="${cellId}"]`);
			if (activeCell) {
				activeCell.classList.add('cell-focused');
			}
		}

		this._activeCellId = cellId;
	}

	/**
	 * Override _handleKeyDown to prevent editing keys from being passed to the main window
	 * when we're in an editable element (contenteditable or textarea)
	 */
	protected override _handleKeyDown(event: KeyboardEvent) {
		const target = event.target as HTMLElement;
		
		// Check if we're editing in a contenteditable or textarea
		const isEditing = target.isContentEditable 
			|| target.tagName === 'TEXTAREA' 
			|| target.tagName === 'INPUT'
			|| target.closest('[contenteditable="true"]');
		
		if (isEditing) {
			// List of keys that should be handled by the editable element, not passed to main window
			const editingKeys = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 
				'Home', 'End', 'Enter', 'Tab'];
			
			// For editing keys or regular typing, don't pass to parent handler
			if (editingKeys.includes(event.key) || event.key.length === 1) {
				// Don't call super._handleKeyDown - just handle focus ring logic
				return;
			}
		}
		
		// For non-editing scenarios, use normal handling
		super._handleKeyDown(event);
	}

	private async _executeCell(cellId: string) {
		console.log('[NotebookView._executeCell] START for cell:', cellId);
		
		const state = this._cellStates.get(cellId);
		console.log('[NotebookView._executeCell] Cell state:', state);
		if (!state || state.executionState === 'running') {
			console.log('[NotebookView._executeCell] Skipping - no state or already running');
			return;
		}

		const cellElement = this._iframeDocument.querySelector(`.notebook-cell[data-cell-id="${cellId}"]`) as HTMLElement;
		if (!cellElement) {
			console.log('[NotebookView._executeCell] Skipping - no cell element found');
			return;
		}

		const outputDiv = cellElement.querySelector('.cell-output') as HTMLElement;
		if (!outputDiv) {
			console.log('[NotebookView._executeCell] Skipping - no output div found');
			return;
		}

		// Get the code from the textarea
		const textarea = cellElement.querySelector('.code-input') as HTMLTextAreaElement;
		const code = textarea?.value || state.source;

		if (!code.trim()) return;

		// Update state
		state.executionState = 'running';
		cellElement.classList.add('cell-running');

		// Show streaming indicator
		outputDiv.innerHTML = `
<div class="output-header">
	<span>Output (running...)</span>
</div>
<div class="output-streaming">
	<div class="spinner"></div>
	<span>Executing code...</span>
</div>`;

		try {
			// Call the code execution API
			// Dispatch a custom event that the parent can handle
			const language = this._notebook?.language || 'python';
			
			// Create event with just data (no callbacks - they don't work cross-compartment)
			const event = new CustomEvent('notebook-execute-code', {
				detail: {
					cellId,
					code,
					language
				}
			});
			
			// reader.js will directly update the DOM via Xray wrappers
			// No need for message listeners - just dispatch the event
			
			// Dispatch to the iframe's own window - reader.js listens here
			console.log('[NotebookView._executeCell] Dispatching notebook-execute-code event');
			this._iframeWindow.dispatchEvent(event);
			
			// Also try window directly in case they differ
			if (this._iframeWindow !== window) {
				window.dispatchEvent(event);
			}

		} catch (error) {
			state.executionState = 'error';
			cellElement.classList.remove('cell-running');

			outputDiv.innerHTML = `
<div class="output-header">
	<span>Output</span>
	<button class="output-close-button" data-action="clear-output">&times;</button>
</div>
<div class="output-content">
	<pre class="output-error">Error: ${this._escapeHtml((error as Error).message)}</pre>
</div>`;
		}
	}

	private _updateAnnotationOverlaySize() {
		const overlay = this._annotationRenderRootEl;
		if (!overlay) return;

		const body = this._iframeDocument.body;
		const docEl = this._iframeDocument.documentElement;

		const width = Math.max(body.scrollWidth, docEl.scrollWidth, body.offsetWidth, docEl.offsetWidth);
		const height = Math.max(body.scrollHeight, docEl.scrollHeight, body.offsetHeight, docEl.offsetHeight);

		overlay.style.width = `${width}px`;
		overlay.style.height = `${height}px`;
	}

	// Required abstract method implementations
	
	toSelector(range: Range): Selector | null {
		let doc = range.commonAncestorContainer.ownerDocument;
		if (!doc) return null;

		let targetNode;
		if (range.startContainer === range.endContainer
				&& range.startOffset == range.endOffset - 1
				&& range.startContainer.nodeType == Node.ELEMENT_NODE) {
			targetNode = range.startContainer.childNodes[range.startOffset];
		}
		else {
			targetNode = range.commonAncestorContainer;
		}

		let targetElement = targetNode.nodeType === Node.ELEMENT_NODE 
			? targetNode as Element 
			: (targetNode.parentElement || doc.body);

		let targetElementQuery = getUniqueSelectorContaining(targetElement);
		if (targetElementQuery) {
			let selector: CssSelector = {
				type: 'CssSelector',
				value: targetElementQuery
			};
			if (range.toString().trim() !== (targetElement.textContent || '').trim()) {
				selector.refinedBy = textPositionFromRange(range, targetElement) || undefined;
			}
			return selector;
		}
		else {
			return textPositionFromRange(range, doc.body);
		}
	}

	toDisplayedRange(selector: Selector): Range | null {
		try {
			if (!selector.refinedBy) return null;
			return textPositionToRange(selector.refinedBy as TextPositionSelector, this._iframeDocument.body);
		} catch (e) {
			console.warn('Failed to convert selector to range', e);
			return null;
		}
	}

	protected _getHistoryLocation(): NavLocation | null {
		return { scrollCoords: [this._iframeWindow.scrollX, this._iframeWindow.scrollY] };
	}

	protected _getAnnotationFromRange(range: Range, type: AnnotationType, color?: string): NewAnnotation<WADMAnnotation> | null {
		if (range.collapsed) {
			return null;
		}

		let text = type === 'highlight' || type === 'underline' ? getInnerText(range).trim() : undefined;
		if (text === '') {
			return null;
		}

		let selector = this.toSelector(range);
		if (!selector) {
			return null;
		}

		let sortIndex = this._getSortIndex(range);

		return {
			type,
			color,
			sortIndex,
			position: selector,
			text,
		};
	}

	private _getSortIndex(range: Range): string {
		let textPosition = textPositionFromRange(range, this._iframeDocument.body);
		if (!textPosition) {
			return '0'.padStart(SORT_INDEX_LENGTH, '0');
		}
		return textPosition.start.toString().padStart(SORT_INDEX_LENGTH, '0');
	}

	protected _navigateToSelector(selector: Selector, options: NavigateOptions = {}): void {
		let range = this.toDisplayedRange(selector);
		if (!range) return;

		scrollIntoView(range, { block: options.block || 'center', behavior: options.behavior || 'smooth' });
	}

	protected _updateViewState(): void {
		let scale = Math.round(this.scale * 1000) / 1000;
		let scrollYPercent = this._iframeWindow.scrollY
			/ (this._iframeDocument.body.scrollHeight - this._iframeDocument.documentElement.clientHeight)
			* 100;
		
		if (Number.isNaN(scrollYPercent)) {
			scrollYPercent = 0;
		}
		scrollYPercent = Math.round(scrollYPercent * 100) / 100;

		let viewState: NotebookViewState = {
			scale,
			scrollYPercent,
		};
		this._options.onChangeViewState(viewState);
	}

	protected _updateViewStats(): void {
		let viewStats: ViewStats = {
			canCopy: !!this._selectedAnnotationIDs.length || !(this._iframeWindow.getSelection()?.isCollapsed ?? true),
			canZoomIn: this.scale === undefined || this.scale < this.MAX_SCALE,
			canZoomOut: this.scale === undefined || this.scale > this.MIN_SCALE,
			canZoomReset: this.scale !== undefined && this.scale !== 1,
			canNavigateBack: this._history.canNavigateBack,
			canNavigateForward: this._history.canNavigateForward,
			canNavigateToFirstPage: false,
			canNavigateToLastPage: false,
			canNavigateToPreviousPage: false,
			canNavigateToNextPage: false,
			canNavigateToPreviousSection: false,
			canNavigateToNextSection: false,
			zoomAutoEnabled: false,
			zoomPageHeightEnabled: false,
			zoomPageWidthEnabled: false,
			flowMode: undefined,
			pageIndex: 0,
			pageLabel: '',
			pagesCount: 1,
			usePhysicalPageNumbers: false,
		};
		this._options.onChangeViewStats(viewStats);
	}

	protected _handleInternalLinkClick(link: HTMLAnchorElement): void {
		this._iframeDocument.location.hash = link.getAttribute('href')!;
		this._updateViewState();
	}

	protected _setScale(scale: number): void {
		this.scale = scale;

		if (this._options.onSetZoom) {
			this._options.onSetZoom(this._iframe, scale);
			this._iframeCoordScaleFactor = scale;
		}

		this._renderAnnotations();
		this._updateViewStats();
	}

	override navigate(location: NavLocation, options?: NavigateOptions): void {
		if (location.annotationID) {
			let annotation = this._annotationsByID.get(location.annotationID);
			if (annotation) {
				this._navigateToSelector(annotation.position, options);
			}
		} else if (location.position) {
			this._navigateToSelector(location.position as Selector, options);
		} else if (location.scrollCoords) {
			this._iframeWindow.scrollTo(location.scrollCoords[0], location.scrollCoords[1]);
		}
	}

	setSidebarOpen(_sidebarOpen: boolean): void {
		// Dispatch resize event to trigger layout recalculation when sidebar opens/closes
		if (!this.initialized) {
			return;
		}
		this._iframeWindow?.dispatchEvent(new Event('resize'));
	}

	// Find functionality
	async setFindState(state: FindState): Promise<void> {
		let previousState = this._findState;
		this._findState = state;

		if (!state.active && previousState && previousState.active !== state.active) {
			if (this._find) {
				this._find = null;
			}
			return;
		}

		if (state.active) {
			if (!previousState
				|| previousState.query !== state.query
				|| previousState.caseSensitive !== state.caseSensitive
				|| previousState.entireWord !== state.entireWord
				|| previousState.active !== state.active) {
				
				this._find = new DefaultFindProcessor({
					findState: { ...state },
					onSetFindState: (result) => {
						this._options.onSetFindState({
							...state,
							result: {
								total: result.total,
								index: result.index,
								snippets: result.snippets,
								annotation: (
									result.range
									&& this._getAnnotationFromRange(result.range.toRange(), 'highlight')
								) ?? undefined,
								currentPageLabel: null,
								currentSnippet: result.snippets[result.index]
							}
						});
					},
				});
				await this._find.run(
					this._searchContext,
					this._lastSelectionRange ?? undefined
				);
				this.findNext();
			}
			else if (previousState && previousState.highlightAll !== state.highlightAll) {
				if (this._find) {
					this._find.findState.highlightAll = state.highlightAll;
				}
				this._renderAnnotations();
			}
		}
	}

	findNext(): void {
		if (this._find) {
			let result = this._find.next();
			if (result) {
				scrollIntoView(result.range.toRange(), { block: 'start' });
			}
			this._renderAnnotations();
		}
	}

	findPrevious(): void {
		if (this._find) {
			let result = this._find.prev();
			if (result) {
				scrollIntoView(result.range.toRange(), { block: 'start' });
			}
			this._renderAnnotations();
		}
	}

	// Outline (simplified - just list cells)
	getOutline(): OutlineItem[] | null {
		if (!this._notebook) return null;

		const items: OutlineItem[] = [];

		for (const cell of this._notebook.cells) {
			if (cell.cell_type === 'markdown') {
				// Extract first heading or first line
				const firstLine = cell.source.split('\n')[0];
				const headingMatch = firstLine.match(/^#+\s*(.+)/);
				const title = headingMatch ? headingMatch[1] : firstLine.slice(0, 50);

				if (title.trim()) {
					items.push({
						title: title,
						location: {
							position: {
								type: 'CssSelector',
								value: `[data-cell-id="${cell.id}"]`,
							} as Selector
						},
						items: [],
					});
				}
			}
		}

		return items.length > 0 ? items : null;
	}

	async print(): Promise<void> {
		if (typeof (this._iframeWindow as any).zoteroPrint === 'function') {
			await (this._iframeWindow as any).zoteroPrint({
				overrideSettings: {
					docURL: '',
				},
			});
		}
		else {
			this._iframeWindow.print();
		}
	}
}

export interface NotebookViewState extends DOMViewState {
	scale?: number;
	scrollYPercent?: number;
}

export interface NotebookViewData {
	buf?: ArrayBuffer;
	content?: string;
}

export default NotebookView;
