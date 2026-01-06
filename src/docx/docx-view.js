import injectCSS from './stylesheets/inject.scss';
import React from 'react';
import { flushSync } from 'react-dom';
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
import { AnnotationOverlay } from "../dom/common/components/overlay/annotation-overlay";

class DOCXView extends DOMView {
	// Required abstract property
	_find = null;
	
	// State for text/image/ink annotation creation
	_pointerDownPosition = null;
	_annotationAction = null;
	
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
		// Guard: Only dispatch if view is fully initialized to avoid blocking during init
		if (!this.initialized) {
			console.log('[DOCXView.setSidebarOpen] Skipping resize dispatch - view not initialized');
			return;
		}
		console.log('[DOCXView.setSidebarOpen] Dispatching resize event');
		this._iframeWindow.dispatchEvent(new Event('resize'));
		console.log('[DOCXView.setSidebarOpen] Resize dispatch done');
	}

	// Override _openAnnotationPopup to handle text/image/ink annotations with absolute positioning
	_openAnnotationPopup(annotation) {
		function debugLog(...args) {
			console.log('[DOCXView._openAnnotationPopup]', ...args);
			try {
				if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
					if (window.parent.Zotero && window.parent.Zotero.debug) {
						window.parent.Zotero.debug('[DOCXView._openAnnotationPopup] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
					}
				}
			} catch (e) {}
		}

		if (!annotation) {
			if (this._selectedAnnotationIDs.length != 1) {
				debugLog('No annotation provided and not exactly one selected annotation');
				return;
			}
			annotation = this._annotationsByID.get(this._selectedAnnotationIDs[0]);
			if (!annotation) {
				debugLog('Selected annotation not found');
				return;
			}
		}

		debugLog('Opening popup for annotation:', { type: annotation.type, id: annotation.id });

		// For text/image/ink annotations, find the rendered element and get its bounding rect
		// This is similar to how notes are handled, but for annotations rendered in SVG overlay
		if (annotation.type === 'text' || annotation.type === 'image' || annotation.type === 'ink') {
			// Find the rendered annotation element in the SVG overlay
			const annotationElem = this._annotationRenderRootEl.querySelector(`[data-annotation-id="${annotation.id}"]`);
			if (annotationElem) {
				debugLog('Found rendered annotation element, getting bounding rect');
				// Get the bounding client rect of the rendered element
				const clientRect = annotationElem.getBoundingClientRect();
				debugLog('Client rect from element:', {
					left: clientRect.left,
					top: clientRect.top,
					right: clientRect.right,
					bottom: clientRect.bottom,
					width: clientRect.width,
					height: clientRect.height
				});
				// Scale the DOM rect (accounts for iframe scaling)
				const scaledRect = this._scaleDOMRect(clientRect);
				debugLog('Scaled rect:', {
					left: scaledRect.left,
					top: scaledRect.top,
					right: scaledRect.right,
					bottom: scaledRect.bottom
				});
				// Convert to viewport rect (for popup positioning)
				const viewportRect = this._clientRectToViewportRect(scaledRect);
				debugLog('Viewport rect:', {
					left: viewportRect.left,
					top: viewportRect.top,
					right: viewportRect.right,
					bottom: viewportRect.bottom
				});
				const popupRect = [viewportRect.left, viewportRect.top, viewportRect.right, viewportRect.bottom];
				debugLog('Setting annotation popup with rect:', popupRect);
				this._options.onSetAnnotationPopup({ rect: popupRect, annotation });
				return;
			}
			else {
				debugLog('WARNING: Annotation element not found in render root, falling back to parent implementation');
			}
		}

		// For other annotation types, use parent implementation
		debugLog('Using parent implementation for annotation type:', annotation.type);
		super._openAnnotationPopup(annotation);
	}

	// Override pointer event handlers to support text/image/ink tools
	_handlePointerDown(event) {
		function debugLog(...args) {
			console.log(...args);
			try {
				if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
					if (window.parent.Zotero && window.parent.Zotero.debug) {
						window.parent.Zotero.debug('[DOCXView._handlePointerDown] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
					}
				}
			} catch (e) {}
		}
		
		// Call parent implementation first
		super._handlePointerDown(event);
		
		// Handle text/image/ink tools
		if ((event.buttons & 1) === 1 && event.isPrimary) {
			if (this._tool.type === 'text' || this._tool.type === 'image' || this._tool.type === 'ink') {
				// Check if we're clicking on an existing annotation
				// If so, don't start creating a new one - let selection happen instead
				// This allows selecting and deleting existing annotations with the tool active
				const annotationIDs = this._getAnnotationsAtPoint ? this._getAnnotationsAtPoint(event.clientX, event.clientY) : [];
				if (annotationIDs && annotationIDs.length > 0) {
					debugLog('[DOCXView._handlePointerDown] Clicked on existing annotation(s):', annotationIDs, '- skipping annotation creation');
					return;
				}
				
				debugLog('[DOCXView._handlePointerDown] Tool type:', this._tool.type, 'Event:', {
					clientX: event.clientX,
					clientY: event.clientY,
					scrollX: this._iframeWindow.scrollX,
					scrollY: this._iframeWindow.scrollY
				});
				
				// Store pointer down position in document coordinates
				// clientX/Y are viewport coordinates, add scroll to get document coordinates
				this._pointerDownPosition = {
					x: event.clientX + this._iframeWindow.scrollX,
					y: event.clientY + this._iframeWindow.scrollY
				};
				debugLog('[DOCXView._handlePointerDown] Pointer down position:', this._pointerDownPosition);
				
				if (this._tool.type === 'ink') {
					// Start ink annotation immediately
					this._annotationAction = {
						type: 'ink',
						paths: [[this._pointerDownPosition.x, this._pointerDownPosition.y]]
					};
					debugLog('[DOCXView._handlePointerDown] Starting ink annotation, action:', this._annotationAction);
					this._previewAnnotation = this._createInkAnnotation(this._annotationAction);
					debugLog('[DOCXView._handlePointerDown] Created preview ink annotation:', this._previewAnnotation ? 'success' : 'failed');
					this._renderAnnotations();
				}
				else if (this._tool.type === 'text') {
					// Start text annotation
					this._annotationAction = {
						type: 'text',
						startX: this._pointerDownPosition.x,
						startY: this._pointerDownPosition.y
					};
					debugLog('[DOCXView._handlePointerDown] Starting text annotation, action:', this._annotationAction);
				}
				else if (this._tool.type === 'image') {
					// Start image annotation
					this._annotationAction = {
						type: 'image',
						startX: this._pointerDownPosition.x,
						startY: this._pointerDownPosition.y
					};
					debugLog('[DOCXView._handlePointerDown] Starting image annotation, action:', this._annotationAction);
				}
				
				event.preventDefault();
			}
		}
	}

	_handlePointerMove(event) {
		function debugLog(...args) {
			console.log(...args);
			try {
				if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
					if (window.parent.Zotero && window.parent.Zotero.debug) {
						window.parent.Zotero.debug('[DOCXView._handlePointerMove] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
					}
				}
			} catch (e) {}
		}
		
		// Call parent implementation first
		super._handlePointerMove(event);
		
		// Handle text/image/ink tools
		if ((event.buttons & 1) === 1 && event.isPrimary && this._annotationAction) {
			// Get current position in document coordinates
			const currentX = event.clientX + this._iframeWindow.scrollX;
			const currentY = event.clientY + this._iframeWindow.scrollY;
			debugLog('[DOCXView._handlePointerMove] Action type:', this._annotationAction.type, 'Current position:', { x: currentX, y: currentY });
			
			if (this._annotationAction.type === 'ink') {
				// Add point to ink path
				this._annotationAction.paths[0].push(currentX, currentY);
				debugLog('[DOCXView._handlePointerMove] Ink path length:', this._annotationAction.paths[0].length);
				this._previewAnnotation = this._createInkAnnotation(this._annotationAction);
				this._renderAnnotations();
			}
			else if (this._annotationAction.type === 'image') {
				// Update image rectangle
				const imageParams = {
					startX: this._annotationAction.startX,
					startY: this._annotationAction.startY,
					endX: currentX,
					endY: currentY
				};
				debugLog('[DOCXView._handlePointerMove] Image rectangle params:', imageParams);
				this._previewAnnotation = this._createImageAnnotation(imageParams);
				debugLog('[DOCXView._handlePointerMove] Created preview image annotation:', this._previewAnnotation ? 'success' : 'failed');
				this._renderAnnotations();
			}
			// Text annotations are created on pointer up
		}
	}

	_handlePointerUp(event) {
		function debugLog(...args) {
			console.log(...args);
			try {
				if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
					if (window.parent.Zotero && window.parent.Zotero.debug) {
						window.parent.Zotero.debug('[DOCXView._handlePointerUp] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
					}
				}
			} catch (e) {}
		}
		
		// Call parent implementation first
		super._handlePointerUp(event);
		
		// Handle text/image/ink tools
		if (event.isPrimary && this._annotationAction) {
			debugLog('[DOCXView._handlePointerUp] Action type:', this._annotationAction.type, 'Has preview:', !!this._previewAnnotation);
			
			if (this._annotationAction.type === 'text') {
				// Create text annotation at click position
				if (this._pointerDownPosition) {
					debugLog('[DOCXView._handlePointerUp] Creating text annotation at:', this._pointerDownPosition);
					const annotation = this._createTextAnnotation(this._pointerDownPosition);
					if (annotation) {
						debugLog('[DOCXView._handlePointerUp] Text annotation created:', { type: annotation.type, sortIndex: annotation.sortIndex, hasPositionData: !!annotation._positionData });
						const addedAnnotation = this._options.onAddAnnotation(annotation, true);
						debugLog('[DOCXView._handlePointerUp] Text annotation added via onAddAnnotation, returned:', addedAnnotation);
						
						// Select the annotation and open popup (like PDF does)
						if (addedAnnotation && addedAnnotation.id) {
							debugLog('[DOCXView._handlePointerUp] Selecting annotation and opening popup, annotation ID:', addedAnnotation.id);
							this._options.onSelectAnnotations([addedAnnotation.id], event);
							this._renderAnnotations(true);
							// Pass the annotation directly to _openAnnotationPopup so it can calculate the rect from position data
							this._openAnnotationPopup(addedAnnotation);
							debugLog('[DOCXView._handlePointerUp] Annotation popup opened');
						}
						else {
							debugLog('[DOCXView._handlePointerUp] WARNING: onAddAnnotation did not return annotation with ID');
							// Fallback: try to open popup anyway
							this._openAnnotationPopup();
						}
					}
					else {
						debugLog('[DOCXView._handlePointerUp] Failed to create text annotation');
					}
				}
				else {
					debugLog('[DOCXView._handlePointerUp] No pointer down position for text annotation');
				}
			}
			else if (this._annotationAction.type === 'image') {
				// Create image annotation if rectangle is large enough
				if (this._previewAnnotation) {
					const rect = this._previewAnnotation._positionData?.rects?.[0];
					debugLog('[DOCXView._handlePointerUp] Image annotation rect:', rect);
					if (rect && Math.abs(rect[2] - rect[0]) > 10 && Math.abs(rect[3] - rect[1]) > 10) {
						debugLog('[DOCXView._handlePointerUp] Image annotation is large enough, adding');
						this._options.onAddAnnotation(this._previewAnnotation, true);
						debugLog('[DOCXView._handlePointerUp] Image annotation added via onAddAnnotation');
					}
					else {
						debugLog('[DOCXView._handlePointerUp] Image annotation too small, discarding');
					}
					this._previewAnnotation = null;
					this._renderAnnotations();
				}
				else {
					debugLog('[DOCXView._handlePointerUp] No preview annotation for image');
				}
			}
			else if (this._annotationAction.type === 'ink') {
				// Create ink annotation if path has enough points
				if (this._previewAnnotation) {
					const pathLength = this._annotationAction.paths[0].length;
					debugLog('[DOCXView._handlePointerUp] Ink annotation path length:', pathLength);
					if (pathLength >= 4) {
						debugLog('[DOCXView._handlePointerUp] Ink annotation has enough points, adding');
						this._options.onAddAnnotation(this._previewAnnotation, true);
						debugLog('[DOCXView._handlePointerUp] Ink annotation added via onAddAnnotation');
					}
					else {
						debugLog('[DOCXView._handlePointerUp] Ink annotation path too short, discarding');
					}
				}
				else {
					debugLog('[DOCXView._handlePointerUp] No preview annotation for ink');
				}
				this._previewAnnotation = null;
				this._renderAnnotations();
			}
			
			// Reset action state
			debugLog('[DOCXView._handlePointerUp] Resetting action state');
			this._annotationAction = null;
			this._pointerDownPosition = null;
		}
	}

	// Create text annotation at a specific position
	_createTextAnnotation(position) {
		function debugLog(...args) {
			console.log(...args);
			try {
				if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
					if (window.parent.Zotero && window.parent.Zotero.debug) {
						window.parent.Zotero.debug('[DOCXView._createTextAnnotation] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
					}
				}
			} catch (e) {}
		}
		
		debugLog('[DOCXView._createTextAnnotation] Called with position:', position);
		const fontSize = this._tool.size || 16;
		debugLog('[DOCXView._createTextAnnotation] Font size:', fontSize);
		const rect = [
			position.x - fontSize / 2,
			position.y - fontSize / 2,
			position.x + fontSize / 2,
			position.y + fontSize / 2
		];
		debugLog('[DOCXView._createTextAnnotation] Calculated rect:', rect);
		debugLog('[DOCXView._createTextAnnotation] Rect details:', {
			left: rect[0],
			top: rect[1],
			right: rect[2],
			bottom: rect[3],
			width: rect[2] - rect[0],
			height: rect[3] - rect[1]
		});
		
		// Create a range for the selector (use body as anchor since text annotations are absolutely positioned)
		// We don't need to find a specific element since the position is stored in _positionData
		debugLog('[DOCXView._createTextAnnotation] Creating range from body element');
		const range = this._iframeDocument.createRange();
		range.selectNode(this._iframeDocument.body);
		debugLog('[DOCXView._createTextAnnotation] Range created, body element:', {
			tagName: this._iframeDocument.body.tagName,
			hasChildren: this._iframeDocument.body.hasChildNodes(),
			childCount: this._iframeDocument.body.childNodes.length
		});
		
		debugLog('[DOCXView._createTextAnnotation] Calling toSelector with range');
		const selector = this.toSelector(range);
		if (!selector) {
			debugLog('[DOCXView._createTextAnnotation] ERROR: Failed to create selector from body range');
			return null;
		}
		debugLog('[DOCXView._createTextAnnotation] Selector created successfully:', {
			type: selector.type,
			value: selector.value || 'N/A',
			hasRefinedBy: !!selector.refinedBy,
			refinedByType: selector.refinedBy?.type || 'N/A'
		});
		
		// Calculate sort index
		debugLog('[DOCXView._createTextAnnotation] Calculating sort index');
		debugLog('[DOCXView._createTextAnnotation] Range for sort index:', {
			startContainer: range.startContainer.nodeName,
			startOffset: range.startOffset,
			endContainer: range.endContainer.nodeName,
			endOffset: range.endOffset
		});
		const getCount = (root, stopContainer, stopOffset) => {
			const iter = this._iframeDocument.createNodeIterator(root, NodeFilter.SHOW_TEXT);
			let count = 0;
			let nodeCount = 0;
			for (let node of iterateWalker(iter)) {
				nodeCount++;
				if (stopContainer?.contains(node)) {
					debugLog('[DOCXView._createTextAnnotation] Found stop container at node', nodeCount, 'count:', count, 'offset:', stopOffset);
					return count + stopOffset;
				}
				const textLength = node.nodeValue?.trim().length || 0;
				count += textLength;
			}
			debugLog('[DOCXView._createTextAnnotation] Reached end of document, total nodes:', nodeCount, 'total count:', count);
			return 0;
		};
		const count = getCount(this._iframeDocument.body, range.startContainer, range.startOffset);
		debugLog('[DOCXView._createTextAnnotation] Character count for sort index:', count);
		const SORT_INDEX_LENGTH = 7;
		let sortIndex = String(count).padStart(SORT_INDEX_LENGTH, '0');
		if (sortIndex.length > SORT_INDEX_LENGTH) {
			sortIndex = sortIndex.substring(0, SORT_INDEX_LENGTH);
		}
		debugLog('[DOCXView._createTextAnnotation] Final sort index:', sortIndex, '(length:', sortIndex.length, ')');
		
		debugLog('[DOCXView._createTextAnnotation] Creating annotation object');
		const annotation = {
			type: 'text',
			color: this._tool.color,
			sortIndex,
			position: selector
		};
		debugLog('[DOCXView._createTextAnnotation] Base annotation object:', {
			type: annotation.type,
			color: annotation.color,
			sortIndex: annotation.sortIndex,
			hasPosition: !!annotation.position,
			positionType: annotation.position?.type
		});
		
		// Store position data for rendering
		annotation._positionData = {
			rects: [rect],
			fontSize,
			rotation: 0
		};
		debugLog('[DOCXView._createTextAnnotation] Position data added:', {
			hasPositionData: !!annotation._positionData,
			hasRects: !!annotation._positionData.rects,
			rectsCount: annotation._positionData.rects?.length || 0,
			fontSize: annotation._positionData.fontSize,
			rotation: annotation._positionData.rotation
		});
		debugLog('[DOCXView._createTextAnnotation] Complete annotation object:', {
			type: annotation.type,
			color: annotation.color,
			sortIndex: annotation.sortIndex,
			hasPosition: !!annotation.position,
			hasPositionData: !!annotation._positionData,
			positionDataRects: annotation._positionData?.rects?.length || 0
		});
		debugLog('[DOCXView._createTextAnnotation] SUCCESS: Text annotation created and ready to return');
		
		return annotation;
	}

	// Create image annotation with rectangle
	_createImageAnnotation({ startX, startY, endX, endY }) {
		function debugLog(...args) {
			console.log(...args);
			try {
				if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
					if (window.parent.Zotero && window.parent.Zotero.debug) {
						window.parent.Zotero.debug('[DOCXView._createImageAnnotation] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
					}
				}
			} catch (e) {}
		}
		
		debugLog('[DOCXView._createImageAnnotation] Called with:', { startX, startY, endX, endY });
		const rect = [
			Math.min(startX, endX),
			Math.min(startY, endY),
			Math.max(startX, endX),
			Math.max(startY, endY)
		];
		debugLog('[DOCXView._createImageAnnotation] Calculated rect:', rect);
		
		// Create a range for the selector (use body as anchor)
		const range = this._iframeDocument.createRange();
		range.selectNode(this._iframeDocument.body);
		const selector = this.toSelector(range);
		if (!selector) {
			debugLog('[DOCXView._createImageAnnotation] Failed to create selector');
			return null;
		}
		debugLog('[DOCXView._createImageAnnotation] Selector created:', selector.type);
		
		// Calculate sort index based on position
		const SORT_INDEX_LENGTH = 7;
		const sortIndex = String(Math.floor(rect[1])).padStart(SORT_INDEX_LENGTH, '0');
		debugLog('[DOCXView._createImageAnnotation] Sort index:', sortIndex);
		
		const annotation = {
			type: 'image',
			color: this._tool.color,
			sortIndex,
			position: selector
		};
		
		// Store position data for rendering
		annotation._positionData = {
			rects: [rect]
		};
		debugLog('[DOCXView._createImageAnnotation] Annotation created:', { type: annotation.type, hasPositionData: !!annotation._positionData });
		
		return annotation;
	}

	// Create ink annotation with path
	_createInkAnnotation(action) {
		function debugLog(...args) {
			console.log(...args);
			try {
				if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
					if (window.parent.Zotero && window.parent.Zotero.debug) {
						window.parent.Zotero.debug('[DOCXView._createInkAnnotation] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
					}
				}
			} catch (e) {}
		}
		
		debugLog('[DOCXView._createInkAnnotation] Called with action:', { type: action.type, pathsLength: action.paths?.[0]?.length || 0 });
		if (!action.paths || action.paths[0].length < 2) {
			debugLog('[DOCXView._createInkAnnotation] Path too short, returning null');
			return null;
		}
		
		// Create a range for the selector (use body as anchor)
		const range = this._iframeDocument.createRange();
		range.selectNode(this._iframeDocument.body);
		const selector = this.toSelector(range);
		if (!selector) {
			debugLog('[DOCXView._createInkAnnotation] Failed to create selector');
			return null;
		}
		debugLog('[DOCXView._createInkAnnotation] Selector created:', selector.type);
		
		// Calculate sort index based on first point
		const SORT_INDEX_LENGTH = 7;
		const sortIndex = String(Math.floor(action.paths[0][1])).padStart(SORT_INDEX_LENGTH, '0');
		debugLog('[DOCXView._createInkAnnotation] Sort index:', sortIndex);
		
		const annotation = {
			type: 'ink',
			color: this._tool.color,
			sortIndex,
			position: selector
		};
		
		// Store position data for rendering
		annotation._positionData = {
			paths: action.paths,
			width: this._tool.size || 2
		};
		debugLog('[DOCXView._createInkAnnotation] Annotation created:', { 
			type: annotation.type, 
			hasPositionData: !!annotation._positionData,
			pathPoints: annotation._positionData.paths[0].length,
			width: annotation._positionData.width
		});
		
		return annotation;
	}

	// Override _renderAnnotations to handle text/image/ink annotations with absolute positioning
	_renderAnnotations(synchronous = false) {
		function debugLog(...args) {
			console.log(...args);
			try {
				if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
					if (window.parent.Zotero && window.parent.Zotero.debug) {
						window.parent.Zotero.debug('[DOCXView._renderAnnotations] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
					}
				}
			} catch (e) {}
		}
		
		debugLog('[DOCXView._renderAnnotations] Called, synchronous:', synchronous);
		if (!this._annotationRenderRootEl) {
			debugLog('[DOCXView._renderAnnotations] No annotation render root, returning');
			return;
		}
		if (!this._showAnnotations) {
			debugLog('[DOCXView._renderAnnotations] Annotations not shown, clearing');
			this._annotationRenderRootEl.replaceChildren();
			return;
		}
		
		debugLog('[DOCXView._renderAnnotations] Processing', this._annotations.length, 'annotations');
		// Process annotations, handling text/image/ink specially
		let displayedAnnotations = this._annotations.map((annotation) => {
			if (this._displayedAnnotationCache.has(annotation)) {
				debugLog('[DOCXView._renderAnnotations] Using cached annotation:', annotation.id);
				return this._displayedAnnotationCache.get(annotation);
			}
			
			let range;
			// For text/image/ink annotations, create range from stored position data
			if ((annotation.type === 'text' || annotation.type === 'image' || annotation.type === 'ink')
					&& annotation._positionData) {
				debugLog('[DOCXView._renderAnnotations] Creating range from position data for:', annotation.type, annotation.id);
				range = this._createRangeFromPositionData(annotation._positionData);
			}
			else {
				debugLog('[DOCXView._renderAnnotations] Creating range from selector for:', annotation.type, annotation.id);
				range = this.toDisplayedRange(annotation.position);
			}
			
			if (!range) {
				debugLog('[DOCXView._renderAnnotations] Failed to create range for annotation:', annotation.id, annotation.type);
				return null;
			}
			
			let displayedAnnotation = {
				id: annotation.id,
				type: annotation.type,
				color: annotation.color,
				sortIndex: annotation.sortIndex,
				text: annotation.text,
				comment: annotation.comment,
				readOnly: annotation.readOnly,
				key: annotation.id,
				range,
				// Pass position data for rendering
				_positionData: annotation._positionData
			};
			this._displayedAnnotationCache.set(annotation, displayedAnnotation);
			debugLog('[DOCXView._renderAnnotations] Created displayed annotation:', annotation.id, annotation.type);
			return displayedAnnotation;
		}).filter(a => !!a);
		
		debugLog('[DOCXView._renderAnnotations] Filtered to', displayedAnnotations.length, 'displayed annotations');
		
		// Handle preview annotation
		if (this._previewAnnotation) {
			debugLog('[DOCXView._renderAnnotations] Processing preview annotation:', this._previewAnnotation.type);
			let range;
			if ((this._previewAnnotation.type === 'text' || this._previewAnnotation.type === 'image' || this._previewAnnotation.type === 'ink')
					&& this._previewAnnotation._positionData) {
				debugLog('[DOCXView._renderAnnotations] Creating range from position data for preview');
				range = this._createRangeFromPositionData(this._previewAnnotation._positionData);
			}
			else {
				debugLog('[DOCXView._renderAnnotations] Creating range from selector for preview');
				range = this.toDisplayedRange(this._previewAnnotation.position);
			}
			if (range) {
				debugLog('[DOCXView._renderAnnotations] Preview annotation range created, adding to displayed');
				displayedAnnotations.push({
					sourceID: this._draggingNoteAnnotation?.id,
					type: this._previewAnnotation.type,
					color: this._previewAnnotation.color,
					sortIndex: this._previewAnnotation.sortIndex,
					text: this._previewAnnotation.text,
					comment: this._previewAnnotation.comment,
					key: '_previewAnnotation',
					range,
					_positionData: this._previewAnnotation._positionData
				});
			}
			else {
				debugLog('[DOCXView._renderAnnotations] Failed to create range for preview annotation');
			}
		}
		
		// Filter visible annotations
		displayedAnnotations = displayedAnnotations.filter(a => {
			if (a.id === this._resizingAnnotationID) {
				return true;
			}
			const boundingRect = this._getBoundingPageRectCached(a.range);
			return isPageRectVisible(boundingRect, this._iframeWindow);
		});
		
		// Get find annotations and highlighted position (from parent logic)
		let findAnnotations = this._find?.getAnnotations();
		if (findAnnotations) {
			displayedAnnotations.push(...findAnnotations.map(a => ({
				...a,
				range: a.range.toRange(),
			})));
		}
		if (this._highlightedPosition) {
			let range = this.toDisplayedRange(this._highlightedPosition);
			if (range) {
				displayedAnnotations.push({
					type: 'highlight',
					color: '#bad6fb', // SELECTION_COLOR
					key: '_highlightedPosition',
					range,
				});
			}
		}
		
		// Filter visible annotations
		displayedAnnotations = displayedAnnotations.filter(a => {
			if (a.id === this._resizingAnnotationID) {
				return true;
			}
			const boundingRect = this._getBoundingPageRectCached(a.range);
			return isPageRectVisible(boundingRect, this._iframeWindow);
		});
		
		// Render using parent's rendering logic
		// Ensure onTextChange is always a function (inherit from parent or provide fallback)
		const onTextChangeProp = typeof this._handleTextAnnotationChange === 'function' 
			? this._handleTextAnnotationChange 
			: ((id, text) => {
				console.error('[DOCXView._renderAnnotations] _handleTextAnnotationChange is not a function, text changes will not be saved', {
					hasMethod: '_handleTextAnnotationChange' in this,
					type: typeof this._handleTextAnnotationChange
				});
			});
		debugLog('[DOCXView._renderAnnotations] onTextChangeProp:', {
			isFunction: typeof onTextChangeProp === 'function',
			hasHandleTextAnnotationChange: '_handleTextAnnotationChange' in this,
			handleTextAnnotationChangeType: typeof this._handleTextAnnotationChange
		});
		let doRender = () => this._annotationRenderRoot.render(
			React.createElement(AnnotationOverlay, {
				iframe: this._iframe,
				annotations: displayedAnnotations,
				selectedAnnotationIDs: this._selectedAnnotationIDs,
				onPointerDown: this._handleAnnotationPointerDown,
				onPointerUp: this._handleAnnotationPointerUp,
				onContextMenu: this._handleAnnotationContextMenu,
				onDragStart: this._handleAnnotationDragStart,
				onResizeStart: this._handleAnnotationResizeStart,
				onResizeEnd: this._handleAnnotationResizeEnd,
				onTextChange: onTextChangeProp
			})
		);
		
		if (synchronous) {
			flushSync(doRender);
		}
		else {
			doRender();
		}
	}

	// Create a Range from position data (rects, paths, etc.)
	_createRangeFromPositionData(positionData) {
		function debugLog(...args) {
			console.log(...args);
			try {
				if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
					if (window.parent.Zotero && window.parent.Zotero.debug) {
						window.parent.Zotero.debug('[DOCXView._createRangeFromPositionData] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
					}
				}
			} catch (e) {}
		}
		
		debugLog('[DOCXView._createRangeFromPositionData] Called with positionData:', {
			hasRects: !!positionData.rects,
			hasPaths: !!positionData.paths,
			rectsLength: positionData.rects?.length || 0,
			pathsLength: positionData.paths?.length || 0
		});
		
		const range = this._iframeDocument.createRange();
		
		// Clean up any existing temporary elements
		if (this._tempAnnotationElements) {
			debugLog('[DOCXView._createRangeFromPositionData] Cleaning up', this._tempAnnotationElements.length, 'temporary elements');
			for (const elem of this._tempAnnotationElements) {
				if (elem.parentNode) {
					elem.parentNode.removeChild(elem);
				}
			}
			this._tempAnnotationElements = [];
		}
		
		if (positionData.rects && positionData.rects.length > 0) {
			// For text/image annotations with rects
			const rect = positionData.rects[0];
			debugLog('[DOCXView._createRangeFromPositionData] Creating range from rect:', rect);
			// Create a temporary element to represent the annotation area
			const tempDiv = this._iframeDocument.createElement('div');
			tempDiv.style.position = 'absolute';
			tempDiv.style.left = `${rect[0]}px`;
			tempDiv.style.top = `${rect[1]}px`;
			tempDiv.style.width = `${rect[2] - rect[0]}px`;
			tempDiv.style.height = `${rect[3] - rect[1]}px`;
			tempDiv.style.pointerEvents = 'none';
			tempDiv.style.visibility = 'hidden';
			tempDiv.style.zIndex = '-1';
			this._iframeDocument.body.appendChild(tempDiv);
			range.selectNode(tempDiv);
			debugLog('[DOCXView._createRangeFromPositionData] Created temp div and range for rect');
			// Store reference to clean up later
			if (!this._tempAnnotationElements) {
				this._tempAnnotationElements = [];
			}
			this._tempAnnotationElements.push(tempDiv);
		}
		else if (positionData.paths && positionData.paths.length > 0) {
			// For ink annotations with paths
			const path = positionData.paths[0];
			debugLog('[DOCXView._createRangeFromPositionData] Creating range from path, length:', path.length);
			// Calculate bounding box
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (let i = 0; i < path.length; i += 2) {
				minX = Math.min(minX, path[i]);
				minY = Math.min(minY, path[i + 1]);
				maxX = Math.max(maxX, path[i]);
				maxY = Math.max(maxY, path[i + 1]);
			}
			debugLog('[DOCXView._createRangeFromPositionData] Path bounding box:', { minX, minY, maxX, maxY });
			// Create a temporary element
			const tempDiv = this._iframeDocument.createElement('div');
			tempDiv.style.position = 'absolute';
			tempDiv.style.left = `${minX}px`;
			tempDiv.style.top = `${minY}px`;
			tempDiv.style.width = `${maxX - minX}px`;
			tempDiv.style.height = `${maxY - minY}px`;
			tempDiv.style.pointerEvents = 'none';
			tempDiv.style.visibility = 'hidden';
			tempDiv.style.zIndex = '-1';
			this._iframeDocument.body.appendChild(tempDiv);
			range.selectNode(tempDiv);
			debugLog('[DOCXView._createRangeFromPositionData] Created temp div and range for path');
			if (!this._tempAnnotationElements) {
				this._tempAnnotationElements = [];
			}
			this._tempAnnotationElements.push(tempDiv);
		}
		else {
			debugLog('[DOCXView._createRangeFromPositionData] No valid position data, returning null');
			return null;
		}
		
		debugLog('[DOCXView._createRangeFromPositionData] Range created successfully');
		return range;
	}
}

export default DOCXView;

