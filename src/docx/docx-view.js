import injectCSS from './stylesheets/inject.scss';
import {
	AnnotationType,
	ArrayRect,
	FindState,
	NavLocation,
	NewAnnotation,
	OutlineItem,
	OverlayPopupParams,
	ViewStats,
	WADMAnnotation
} from "../common/types";
import {
	getStartElement,
	moveRangeEndsIntoTextNodes,
	PersistentRange,
	splitRangeToTextNodes,
	getBoundingPageRect,
	getInnerText
} from "../dom/common/lib/range";
import { FragmentSelector, FragmentSelectorConformsTo, isFragment, Selector, CssSelector, textPositionFromRange, textPositionToRange } from "../dom/common/lib/selector";
import DOMView, {
	DOMViewOptions,
	DOMViewState,
	NavigateOptions,
	ReflowableAppearance
} from "../dom/common/dom-view";
import { closestElement, getContainingBlock, iterateWalker } from "../dom/common/lib/nodes";
import { A11Y_VIRT_CURSOR_DEBOUNCE_LENGTH } from "../common/defines";
import { debounce } from '../common/lib/debounce';
import { placeA11yVirtualCursor } from '../common/lib/utilities';
import { DEFAULT_REFLOWABLE_APPEARANCE } from "../dom/common/defines";
import DefaultFindProcessor, { createSearchContext } from "../dom/common/lib/find";
import { getUniqueSelectorContaining } from "../dom/common/lib/unique-selector";
import { scrollIntoView } from "../dom/common/lib/scroll-into-view";
import { isPageRectVisible } from "../dom/common/lib/rect";
import { debounceUntilScrollFinishes } from "../common/lib/utilities";

class DOCXView extends DOMView {
	// Required abstract property
	_find = null;
	
	constructor(options) {
		super(options);
		
		this._contentContainer = null;
		this._htmlContent = '';
		this._styles = '';
		this._outline = [];
		
		if (!options.data) {
			throw new Error('DOCXView: options.data is required');
		}
		
		if (options.data.html) {
			this._htmlContent = options.data.html;
			this._styles = options.data.styles || '';
		}
		else if (options.data.buf) {
			// Convert DOCX buffer to HTML
			this._convertDOCXToHTML(options.data.buf);
		}
		else if (options.data.url) {
			// URL-based loading - will be handled in _handleViewCreated
			this._htmlContent = '';
		}
		else {
			throw new Error('DOCXView: html, buf, or url is required in options.data');
		}
	}

	_getSrcDoc() {
		return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>';
	}

	async _handleViewCreated(viewState) {
		await super._handleViewCreated(viewState);
		
		this._contentContainer = this._iframeDocument.createElement('div');
		this._contentContainer.className = 'docx-content';
		this._iframeDocument.body.appendChild(this._contentContainer);
		
		// Load and render HTML content
		// This now waits for content to be fully rendered and ready
		await this._renderContent();
		
		// Set up find functionality
		this._initFind();
		
		// Load outline/structure
		await this._loadOutline();
		
		// Ensure content is fully ready before initialization completes
		// This matches the PDF viewer's pattern of waiting for document initialization
		// The content should already be ready from _renderContent(), but this provides
		// an additional guarantee that the DOM is stable and ready for interaction
		await new Promise(resolve => {
			// Use setTimeout to ensure any pending DOM operations complete
			this._iframeWindow.setTimeout(() => {
				resolve();
			}, 0);
		});
	}

	async _convertDOCXToHTML(buf) {
		// This will be called from the main thread via DOCXWorker
		// For now, we'll handle it in the initialization
		try {
			// In a real implementation, this would call Zotero.DOCXWorker.convertToHTML()
			// For now, we'll assume the HTML is provided in options.data
		}
		catch (e) {
			console.error('Failed to convert DOCX to HTML:', e);
			throw e;
		}
	}

	async _renderContent() {
		if (!this._htmlContent) {
			return;
		}
		
		// Inject styles if provided
		if (this._styles) {
			const styleElement = this._iframeDocument.createElement('style');
			styleElement.textContent = this._styles;
			this._iframeDocument.head.appendChild(styleElement);
		}
		
		// Set base styles for DOCX content
		// Use CSS variables for theme-aware colors that will update dynamically
		const baseStyle = this._iframeDocument.createElement('style');
		baseStyle.id = 'docx-base-styles';
		baseStyle.textContent = `
			.docx-content {
				padding: 2em;
				max-width: 800px;
				margin: 0 auto;
				font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
				line-height: 1.6;
				background-color: var(--background-color, #ffffff);
				color: var(--text-color, #121212);
			}
			.docx-content h1, .docx-content h2, .docx-content h3,
			.docx-content h4, .docx-content h5, .docx-content h6 {
				margin-top: 1.5em;
				margin-bottom: 0.5em;
				font-weight: bold;
				color: var(--text-color, #121212);
			}
			.docx-content p {
				margin: 0.5em 0;
				color: var(--text-color, #121212);
			}
			.docx-content table {
				border-collapse: collapse;
				width: 100%;
				margin: 1em 0;
			}
			.docx-content table td, .docx-content table th {
				border: 1px solid var(--border-color, rgba(0, 0, 0, 0.2));
				padding: 8px;
				color: var(--text-color, #121212);
			}
		`;
		this._iframeDocument.head.appendChild(baseStyle);
		
		// Render HTML content
		this._contentContainer.innerHTML = this._htmlContent;
		
		// Wait for DOM to be fully parsed and rendered before proceeding
		// This ensures the content is ready for interaction, similar to how PDF waits for document initialization
		await this._waitForContentReady();
		
		// Annotation handling is done automatically by the base DOMView class
		// through pointer events (pointerdown, pointerup) and selectionchange events
		// No additional setup needed here
	}

	/**
	 * Wait for content to be fully rendered and ready for interaction.
	 * This matches the PDF viewer's pattern of waiting for document initialization.
	 */
	async _waitForContentReady() {
		// Wait for the next animation frame to ensure DOM is parsed
		await new Promise(resolve => {
			this._iframeWindow.requestAnimationFrame(() => {
				// Wait for one more frame to ensure layout is complete
				this._iframeWindow.requestAnimationFrame(() => {
					resolve();
				});
			});
		});

		// Wait for any images to load (if any)
		const images = this._contentContainer.querySelectorAll('img');
		if (images.length > 0) {
			await Promise.all(Array.from(images).map(img => {
				if (img.complete) {
					return Promise.resolve();
				}
				return new Promise((resolve, reject) => {
					img.onload = resolve;
					img.onerror = resolve; // Resolve even on error to not block initialization
					// Timeout after 5 seconds to prevent indefinite waiting
					setTimeout(resolve, 5000);
				});
			}));
		}
	}

	async _loadOutline() {
		// Load document structure (headings) for outline navigation
		// This would call Zotero.DOCXWorker.getDocumentStructure()
		const headings = this._contentContainer.querySelectorAll('h1, h2, h3, h4, h5, h6');
		
		const outline = [];
		for (let heading of headings) {
			const level = parseInt(heading.tagName.charAt(1));
			const title = heading.textContent.trim();
			const id = heading.id || `heading-${outline.length}`;
			
			// Create ID if not present
			if (!heading.id) {
				heading.id = id;
			}
			
			// Create a range for the heading to generate a selector
			const range = this._iframeDocument.createRange();
			range.selectNode(heading);
			const selector = this.toSelector(range);
			
			if (selector) {
				outline.push({
					level,
					title,
					location: { position: selector },
					items: [],
					expanded: true
				});
			}
		}
		
		// Build hierarchical outline structure
		const hierarchicalOutline = [];
		const stack = [];
		for (let item of outline) {
			while (stack.length && stack[stack.length - 1].level >= item.level) {
				stack.pop();
			}
			if (stack.length) {
				if (!stack[stack.length - 1].items) {
					stack[stack.length - 1].items = [];
				}
				stack[stack.length - 1].items.push(item);
			}
			else {
				hierarchicalOutline.push(item);
			}
			stack.push(item);
		}
		
		this._outline = hierarchicalOutline;
		this._options.onSetOutline(hierarchicalOutline);
	}

	_initFind() {
		// Find will be initialized when setFindState is called
		// This method is kept for compatibility but find is lazy-loaded
	}

	setFindState(state) {
		const previousState = this._findState;
		this._findState = state;
		
		if (!state.active && previousState && previousState.active !== state.active) {
			// Close find popup
			if (this._find) {
				this._find.cancel();
				this._find = null;
				this._handleViewUpdate();
			}
		}
		else if (state.active) {
			if (!this._find
					|| !previousState
					|| previousState.query !== state.query
					|| previousState.caseSensitive !== state.caseSensitive
					|| previousState.entireWord !== state.entireWord
					|| previousState.active !== state.active) {
				// Initialize or recreate find processor
				this._find?.cancel();
				
				// Get all text nodes from content container
				const textNodes = Array.from(this._contentContainer.querySelectorAll('*'))
					.flatMap(el => {
						const walker = this._iframeDocument.createTreeWalker(
							el,
							NodeFilter.SHOW_TEXT,
							null
						);
						const nodes = [];
						let node;
						while (node = walker.nextNode()) {
							if (node.textContent.trim()) {
								nodes.push(node);
							}
						}
						return nodes;
					});
				
				const searchContext = createSearchContext(textNodes);
				this._find = new DefaultFindProcessor({
					findState: {
						query: state.query,
						caseSensitive: state.caseSensitive,
						entireWord: state.entireWord,
						highlightAll: state.highlightAll,
						active: true,
						popupOpen: state.popupOpen
					},
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
								currentSnippet: result.snippets[result.index]
							}
						});
						if (result.range) {
							// Record the result that screen readers should focus on
							this._a11yVirtualCursorTarget = getStartElement(result.range.toRange());
						}
					},
				});
				
				// Start the search
				this._find.run(searchContext).then(() => {
					// Navigate to first result
					if (this._find && this._find.next()) {
						this._renderAnnotations();
					}
				});
			}
			else if (previousState && previousState.highlightAll !== state.highlightAll) {
				// Update highlightAll setting
				this._find.findState.highlightAll = state.highlightAll;
				this._renderAnnotations();
			}
		}
	}

	findNext() {
		if (this._find) {
			const result = this._find.next();
			if (result) {
				scrollIntoView(result.range.toRange(), { block: 'start' });
			}
			this._renderAnnotations();
		}
	}

	findPrevious() {
		if (this._find) {
			const result = this._find.prev();
			if (result) {
				scrollIntoView(result.range.toRange(), { block: 'start' });
			}
			this._renderAnnotations();
		}
	}

	// Implement required abstract methods from DOMView
	getData() {
		return {
			html: this._htmlContent,
			styles: this._styles
		};
	}

	toSelector(range) {
		if (range.collapsed) {
			return null;
		}
		
		const doc = range.commonAncestorContainer.ownerDocument;
		if (!doc) return null;
		
		let targetNode;
		// In most cases, the range will wrap a single child of the
		// commonAncestorContainer. Build a selector targeting that element.
		if (range.startContainer === range.endContainer
				&& range.startOffset == range.endOffset - 1
				&& range.startContainer.nodeType == Node.ELEMENT_NODE) {
			targetNode = range.startContainer.childNodes[range.startOffset];
		}
		else {
			targetNode = range.commonAncestorContainer;
		}
		
		const targetElement = closestElement(targetNode);
		if (!targetElement) {
			return null;
		}
		
		const targetElementQuery = getUniqueSelectorContaining(targetElement);
		if (targetElementQuery) {
			const selector = {
				type: 'CssSelector',
				value: targetElementQuery
			};
			// If the user has highlighted the full text content of the element, no need to add a
			// TextPositionSelector.
			if (range.toString().trim() !== (targetElement.textContent || '').trim()) {
				selector.refinedBy = textPositionFromRange(range, targetElement) || undefined;
			}
			return selector;
		}
		else {
			return textPositionFromRange(range, doc.body);
		}
	}

	toDisplayedRange(selector) {
		switch (selector.type) {
			case 'CssSelector': {
				if (selector.refinedBy && selector.refinedBy.type != 'TextPositionSelector') {
					throw new Error('CssSelectors can only be refined by TextPositionSelectors');
				}
				const root = this._iframeDocument.querySelector(selector.value);
				if (!root) {
					console.error(`Unable to locate selector root for selector '${selector.value}'`);
					return null;
				}
				let range;
				if (selector.refinedBy) {
					range = textPositionToRange(selector.refinedBy, root);
				}
				else {
					range = this._iframeDocument.createRange();
					range.selectNodeContents(root);
				}
				if (!range.getClientRects().length) {
					try {
						range.selectNode(range.commonAncestorContainer);
					}
					catch (e) {
						return null;
					}
				}
				return range;
			}
			case 'TextPositionSelector': {
				if (selector.refinedBy) {
					throw new Error('Refinement of TextPositionSelectors is not supported');
				}
				return textPositionToRange(selector, this._iframeDocument.body);
			}
			default:
				throw new Error(`Unsupported Selector.type: ${selector.type}`);
		}
	}

	_navigateToSelector(selector, options = {}) {
		const range = this.toDisplayedRange(selector);
		if (!range) {
			console.warn('Unable to resolve selector to range', selector);
			return;
		}
		const elem = getStartElement(range);
		if (elem) {
			elem.scrollIntoView(options);
			// Remember which node was navigated to for screen readers
			debounceUntilScrollFinishes(this._iframeDocument).then(() => {
				this._a11yVirtualCursorTarget = elem;
			});
		}

		if (options.ifNeeded && isPageRectVisible(getBoundingPageRect(range), this._iframeWindow, 0)) {
			return;
		}

		scrollIntoView(range, options);
	}

	_getHistoryLocation() {
		return { scrollCoords: [this._iframeWindow.scrollX, this._iframeWindow.scrollY] };
	}

	_getAnnotationFromRange(range, type, color) {
		// Move range ends into text nodes for accurate selection
		range = moveRangeEndsIntoTextNodes(range);
		if (range.collapsed) {
			return null;
		}
		
		let text;
		if (type == 'highlight' || type == 'underline') {
			// Use splitRangeToTextNodes for better handling of multi-block selections (like EPUB)
			text = '';
			let lastSplitRange;
			for (let splitRange of splitRangeToTextNodes(range)) {
				if (lastSplitRange) {
					let lastSplitRangeContainer = closestElement(lastSplitRange.commonAncestorContainer);
					let lastSplitRangeBlock = lastSplitRangeContainer && getContainingBlock(lastSplitRangeContainer);
					let splitRangeContainer = closestElement(splitRange.commonAncestorContainer);
					let splitRangeBlock = splitRangeContainer && getContainingBlock(splitRangeContainer);
					if (lastSplitRangeBlock !== splitRangeBlock) {
						text += '\n\n';
					}
				}
				text += splitRange.toString().replace(/\s+/g, ' ');
				lastSplitRange = splitRange;
			}
			text = text.trim();

			// If this annotation type wants text, but we didn't get any, abort
			if (!text) {
				return null;
			}
		}
		else {
			text = undefined;
		}

		const selector = this.toSelector(range);
		if (!selector) {
			return null;
		}

		// Calculate sort index based on character position from body start (like snapshot view)
		const getCount = (root, stopContainer, stopOffset) => {
			const iter = this._iframeDocument.createNodeIterator(root, NodeFilter.SHOW_TEXT);
			let count = 0;
			for (let node of iterateWalker(iter)) {
				if (stopContainer?.contains(node)) {
					return count + stopOffset;
				}
				count += node.nodeValue.trim().length;
			}
			return 0;
		};

		const count = getCount(this._iframeDocument.body, range.startContainer, range.startOffset);
		// Use 7 digits to match snapshot view format (validation accepts 7-8 digits)
		// This matches the SORT_INDEX_LENGTH constant used in snapshot-view
		const SORT_INDEX_LENGTH = 7;
		let sortIndex = String(count).padStart(SORT_INDEX_LENGTH, '0');
		if (sortIndex.length > SORT_INDEX_LENGTH) {
			sortIndex = sortIndex.substring(0, SORT_INDEX_LENGTH);
		}

		return {
			type,
			color,
			sortIndex,
			position: selector,
			text
		};
	}

	_updateViewState() {
		const scale = Math.round(this.scale * 1000) / 1000; // Three decimal places
		const scrollYPercent = this._iframeWindow.scrollY
			/ (this._iframeDocument.body.scrollHeight - this._iframeDocument.documentElement.clientHeight)
			* 100;
		// Keep it within [0, 100]
		const normalizedScrollY = isNaN(scrollYPercent) ? 0 : Math.max(0, Math.min(100, scrollYPercent));
		const scrollYPercentRounded = Math.round(normalizedScrollY * 10) / 10; // One decimal place
		
		const viewState = {
			scale,
			scrollYPercent: scrollYPercentRounded,
			appearance: this.appearance,
		};
		this._options.onChangeViewState(viewState);
	}

	_updateViewStats() {
		const viewStats = {
			canCopy: !!this._selectedAnnotationIDs.length || !(this._iframeWindow.getSelection()?.isCollapsed ?? true),
			canZoomIn: this.scale === undefined || this.scale < this.MAX_SCALE,
			canZoomOut: this.scale === undefined || this.scale > this.MIN_SCALE,
			canZoomReset: this.scale !== undefined && this.scale !== 1,
			canNavigateBack: this._history.canNavigateBack,
			canNavigateForward: this._history.canNavigateForward,
			appearance: this.appearance,
		};
		this._options.onChangeViewStats(viewStats);
	}

	_handleInternalLinkClick(link) {
		const href = link.getAttribute('href');
		if (!href) {
			return;
		}
		
		// Handle internal links (anchors)
		if (href.startsWith('#')) {
			const element = this._contentContainer.querySelector(href);
			if (element) {
				const range = this._iframeDocument.createRange();
				range.selectNode(element);
				const selector = this.toSelector(range);
				if (selector) {
					this.navigate({ position: selector }, { behavior: 'smooth', block: 'center' });
				}
			}
		}
		else {
			// External links are handled by the parent class
			this._options.onOpenLink(href);
		}
	}

	_setScale(scale) {
		this.scale = scale;
		this._iframeDocument.documentElement.style.setProperty('--scale', String(scale));
	}

	async print() {
		// Simple print implementation for DOCX
		this._iframeWindow.print();
	}

	// Override other required methods from DOMView
	setFontFamily(fontFamily) {
		if (this._contentContainer) {
			this._contentContainer.style.fontFamily = fontFamily || '';
		}
		super.setFontFamily(fontFamily);
	}

	setHyphenate(hyphenate) {
		if (this._contentContainer) {
			this._contentContainer.style.hyphens = hyphenate ? 'auto' : 'none';
		}
		super.setHyphenate(hyphenate);
	}

	/**
	 * Override _updateColorScheme to also update DOCX content container
	 * This enables dynamic theme switching without reloading, matching PDF behavior
	 */
	_updateColorScheme() {
		function debugLog(...args) {
			console.log(...args);
			try {
				if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
					if (window.parent.Zotero && window.parent.Zotero.debug) {
						window.parent.Zotero.debug('[DOCXView] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
					}
				}
			} catch (e) {}
		}
		debugLog('[DOCXView._updateColorScheme] Called', {
			lightTheme: this._lightTheme?.id,
			darkTheme: this._darkTheme?.id,
			colorScheme: this._colorScheme,
			themeColorScheme: this._themeColorScheme
		});
		// Call parent implementation to update document root and annotation root
		super._updateColorScheme();
		
		// Also update the content container and set border color variable
		if (this._iframeDocument && this._theme) {
			const root = this._iframeDocument.documentElement;
			
			// Calculate border color based on theme (lighter for dark themes, darker for light themes)
			// Use a semi-transparent color that works with both light and dark backgrounds
			const isDark = this._themeColorScheme === 'dark';
			const borderColor = isDark 
				? 'rgba(255, 255, 255, 0.2)' 
				: 'rgba(0, 0, 0, 0.2)';
			
			// Set border color CSS variable for use in styles
			root.style.setProperty('--border-color', borderColor);
			
			// Update content container directly if it exists
			if (this._contentContainer) {
				this._contentContainer.style.backgroundColor = this._theme.background;
				this._contentContainer.style.color = this._theme.foreground;
			}
			
			// Clear annotation cache and re-render annotations after theme change
			// This ensures annotations are re-rendered with the new theme and handles
			// any DOM changes that might have occurred
			if (this.initialized) {
				// Clear caches to force fresh rendering
				this._displayedAnnotationCache = new WeakMap();
				this._boundingPageRectCache = new WeakMap();
				
				// Re-render annotations after a brief delay to ensure DOM is stable
				this._iframeWindow.requestAnimationFrame(() => {
					this._renderAnnotations();
				});
			}
		}
	}

	setSidebarOpen(_sidebarOpen) {
		// Dispatch resize event to trigger layout recalculation when sidebar opens/closes
		// Similar to EPUBView implementation
		this._iframeWindow.dispatchEvent(new Event('resize'));
	}
}

export default DOCXView;

