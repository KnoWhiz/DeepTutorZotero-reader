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
	getStartElement
} from "../common/lib/range";
import {
	CssSelector,
	textPositionFromRange,
	Selector,
	textPositionToRange
} from "../common/lib/selector";
import DOMView, {
	DOMViewState,
	NavigateOptions
} from "../common/dom-view";
import { getUniqueSelectorContaining } from "../common/lib/unique-selector";
import {
	closestElement,
	getVisibleTextNodes,
	iterateWalker
} from "../common/lib/nodes";
import DefaultFindProcessor, { createSearchContext } from "../common/lib/find";
import injectCSS from './stylesheets/inject.scss';
import darkReaderJS from '!!raw-loader!darkreader/darkreader';
import type { DynamicThemeFix } from "darkreader";
import { isPageRectVisible } from "../common/lib/rect";
import { debounceUntilScrollFinishes } from "../../common/lib/utilities";
import { scrollIntoView } from "../common/lib/scroll-into-view";
import { SORT_INDEX_LENGTH, SORT_INDEX_LENGTH_OLD } from "./defines";
import { FocusMode } from "./focus-mode";

class SnapshotView extends DOMView<SnapshotViewState, SnapshotViewData> {
	protected _find: DefaultFindProcessor | null = null;

	private _isDynamicThemeSupported = true;

	protected _focusMode!: FocusMode;

	// State for text/image/ink annotation tools
	private _pointerDownPosition: { x: number; y: number } | null = null;
	private _annotationAction: {
		type: string;
		paths?: number[][];
		startX?: number;
		startY?: number;
	} | null = null;

	/**
	 * Override setAnnotations to reconstruct _positionData for text/image/ink annotations
	 * that were loaded from the database. The position data is stored inside
	 * the position object but needs to be extracted to _positionData for rendering.
	 */
	override setAnnotations(annotations: WADMAnnotation[]) {
		// Reconstruct _positionData from position for text/image/ink annotations
		for (const annotation of annotations) {
			if (annotation.type === 'text' || annotation.type === 'image' || annotation.type === 'ink') {
				const position = annotation.position as any;
				if (position && !((annotation as any)._positionData)) {
					// Extract position data from the position object
					if (position.rects) {
						(annotation as any)._positionData = {
							rects: position.rects,
							fontSize: position.fontSize,
							rotation: position.rotation || 0
						};
					} else if (position.paths) {
						(annotation as any)._positionData = {
							paths: position.paths,
							width: position.width || 2
						};
					}
				}
			}
		}
		super.setAnnotations(annotations);
	}

	private get _searchContext() {
		let searchContext = createSearchContext(getVisibleTextNodes(this._iframeDocument.body));
		Object.defineProperty(this, '_searchContext', { value: searchContext });
		return searchContext;
	}

	protected async _getSrcDoc() {
		if (this._options.data.srcDoc) {
			return this._options.data.srcDoc;
		}
		else if (this._options.data.buf || this._options.data.url !== undefined) {
			let buf;
			if (this._options.data.buf) {
				buf = this._options.data.buf;
			}
			else {
				buf = await fetch(this._options.data.url!).then(r => r.arrayBuffer());
			}
			let text = new TextDecoder('utf-8').decode(buf);
			delete this._options.data.buf;
			let doc = new DOMParser().parseFromString(text, 'text/html');

			for (let base of doc.querySelectorAll('base')) {
				base.remove();
			}
			if (this._options.data.url !== undefined) {
				let base = doc.createElement('base');
				base.href = this._options.data.url;
				doc.head.prepend(base);
			}

			for (let cspMeta of Array.from(doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]'))) {
				cspMeta.remove();
			}
			let cspMeta = doc.createElement('meta');
			cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
			cspMeta.setAttribute('content', this._getCSP());
			doc.head.prepend(cspMeta);

			// Fix Twitter snapshots breaking because of <noscript> styles
			for (let noscript of Array.from(doc.querySelectorAll('noscript'))) {
				noscript.remove();
			}

			let doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : '';
			let html = doc.documentElement.outerHTML;
			return doctype + html;
		}
		else {
			throw new Error('buf, url, or srcDoc is required');
		}
	}

	getData() {
		return {
			srcDoc: this._iframe.srcdoc,
			url: this._iframeDocument.head.querySelector('base')?.href,
			importedFromURL: this._options.data.importedFromURL,
		};
	}

	protected override _handleIFrameLoaded() {
		let maxRules = this._options.preview ? 100 : 500;
		let numRules = 0;

		let foundSFImg = false;
		let foundFontFace = false;
		for (let sheet of this._iframeDocument.styleSheets) {
			// Ignore SingleFile embedded image stylesheet
			// https://github.com/gildas-lormeau/single-file-core/blob/1b6cecbe0/core/index.js#L1548-L1560
			if (!foundSFImg && sheet.ownerNode?.textContent?.startsWith(':root{--sf-img-')) {
				foundSFImg = true;
				continue;
			}
			// Ignore SingleFile font-face stylesheet
			// https://github.com/gildas-lormeau/single-file-core/blob/1b6cecbe0/core/index.js#L1047-L1055
			if (!foundFontFace && sheet.ownerNode?.textContent?.startsWith('@font-face{')
				&& Array.prototype.every.call(
					sheet.cssRules,
					rule => rule.constructor.name === 'CSSFontFaceRule'
				)
			) {
				foundFontFace = true;
				continue;
			}
			numRules += sheet.cssRules.length;
			if (numRules > maxRules) {
				this._isDynamicThemeSupported = false;
				break;
			}
		}

		this._focusMode = new FocusMode(this._iframeDocument);

		this._iframeDocument.addEventListener('visibilitychange', this._handleVisibilityChange.bind(this));

		return super._handleIFrameLoaded();
	}

	protected override async _handleViewCreated(viewState: Partial<Readonly<SnapshotViewState>>) {
		await super._handleViewCreated(viewState);

		let style = this._iframeDocument.createElement('style');
		style.innerHTML = injectCSS;
		this._iframeDocument.head.append(style);

		// Make document content immutable (read-only viewer)
		this._makeContentImmutable();

		// Validate viewState and its properties
		// Also make sure this doesn't trigger _updateViewState
		this._setScale(viewState.scale ?? 1);
		if (this._options.location) {
			this.navigate(this._options.location, { behavior: 'instant' });
		}
		else if (viewState.scrollYPercent !== undefined) {
			this._iframeWindow.scrollTo({
				top: viewState.scrollYPercent
					/ 100
					* (this._iframeDocument.body.scrollHeight - this._iframeDocument.documentElement.clientHeight)
			});
		}

		this._initOutline();

		try {
			// Update old sortIndexes (determined based on length)
			// We used to count characters from <html>, which was volatile and led
			// to unnecessarily large sortIndexes. Now we count from <body>.
			if (!this._options.readOnly) {
				this._options.onUpdateAnnotations(this._annotations
					.filter(a => !a.readOnly && a.sortIndex && a.sortIndex.length === SORT_INDEX_LENGTH_OLD)
					.map((a) => {
						let range = this.toDisplayedRange(a.position);
						if (!range) {
							return null;
						}
						return { id: a.id, sortIndex: this._getSortIndex(range) };
					})
					.filter(Boolean) as Partial<WADMAnnotation>[]
				);
			}
		}
		catch (e) {
			console.warn('Failed to update sortIndexes', e);
		}
	}

	private _getSnapshotLocation() {
		let singleFileComment = this._iframeDocument.documentElement.firstChild;
		if (singleFileComment?.nodeType === Node.COMMENT_NODE
				&& singleFileComment.nodeValue!.trim().startsWith('Page saved with SingleFile')) {
			let matches = singleFileComment.nodeValue!.match(/^\s*url: (https?:\/\/\S+)/m);
			if (matches) {
				return matches[1];
			}
		}
		return null;
	}

	private _initOutline() {
		let bodyFontSize = parseFloat(getComputedStyle(this._iframeDocument.body).fontSize);
		let flatOutline: (OutlineItem & { level: number })[] = [];
		// Create a flat outline array from the headings on the page
		for (let heading of this._iframeDocument.body.querySelectorAll('h1, h2, h3, h4, h5, h6') as NodeListOf<HTMLElement>) {
			// If the site uses semantic HTML, we can try to skip probably-irrelevant headings
			if (heading.closest('aside, nav, footer, template, [hidden]')) {
				continue;
			}
			if (!heading.innerText.trim()) {
				continue;
			}
			let headingFontSize = parseFloat(getComputedStyle(heading).fontSize);
			if (headingFontSize <= bodyFontSize) {
				continue;
			}

			let range = this._iframeDocument.createRange();
			range.selectNode(heading);
			let selector = this.toSelector(range);
			if (!selector) {
				continue;
			}
			let level = parseInt(heading.tagName[1]);
			flatOutline.push({
				title: heading.innerText.trim(),
				location: { position: selector },
				items: [],
				expanded: true,
				level
			});
		}
		// For each heading, move subsequent headings with deeper levels into its items array
		let outline = [];
		let stack: (OutlineItem & { level: number })[] = [];
		for (let item of flatOutline) {
			while (stack.length && stack[stack.length - 1].level >= item.level) {
				stack.pop();
			}
			if (stack.length) {
				stack[stack.length - 1].items!.push(item);
			}
			else {
				outline.push(item);
			}
			stack.push(item);
		}
		this._options.onSetOutline(outline);
	}

	/**
	 * Make document content immutable - snapshot viewer is read-only.
	 * Removes contenteditable attributes and disables form elements.
	 * Note: Annotation textareas (in shadow root) are still editable.
	 */
	private _makeContentImmutable() {
		// Remove contenteditable attribute from all elements
		const editableElements = this._iframeDocument.querySelectorAll('[contenteditable]');
		for (const el of editableElements) {
			el.setAttribute('contenteditable', 'false');
		}

		// Disable all form inputs, textareas, and selects
		const formElements = this._iframeDocument.querySelectorAll('input, textarea, select, button') as NodeListOf<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>;
		for (const el of formElements) {
			el.disabled = true;
			el.setAttribute('readonly', 'true');
		}

		// Set document.designMode to off (prevents entire document editing)
		this._iframeDocument.designMode = 'off';

		// Prevent beforeinput events which could trigger editing on document content
		// BUT allow input in annotation textareas (which are in the shadow root)
		// Check, for every keystroke, whether the target is inside the annotation shadow root
		this._iframeDocument.addEventListener('beforeinput', (e) => {
			// Use composedPath() to get the full event path through shadow DOM boundaries.
			// We check if our annotation shadow root is in the path - this works because
			// path.includes() uses strict equality (===) which works across iframe realms,
			// unlike instanceof checks which can fail across different JavaScript contexts.
			const path = e.composedPath();
			const isInAnnotationOverlay = path.includes(this._annotationShadowRoot);
			
			if (isInAnnotationOverlay) {
				return; // Allow annotation input
			}
			// Block all other input (document content)
			e.preventDefault();
		}, true);
	}

	protected _getAnnotationFromRange(range: Range, type: AnnotationType, color?: string): NewAnnotation<WADMAnnotation> | null {
		if (range.collapsed) {
			return null;
		}
		let text = type == 'highlight' || type == 'underline' ? getInnerText(range).trim() : undefined;
		// If this annotation type wants text, but we didn't get any, abort
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
			text
		};
	}

	private _getSortIndex(range: Range) {
		let getCount = (root: Node, stopContainer?: Node, stopOffset?: number) => {
			let iter = this._iframeDocument.createNodeIterator(root, NodeFilter.SHOW_TEXT);
			let count = 0;
			for (let node of iterateWalker(iter)) {
				if (stopContainer?.contains(node)) {
					return count + stopOffset!;
				}
				count += node.nodeValue!.trim().length;
			}
			// If we never terminated, just return 0
			return 0;
		};

		let count: number;
		if (this._focusMode.enabled) {
			let newRange = this._focusMode.mapRangeFromFocus(range);
			if (newRange) {
				count = getCount(this._focusMode.originalRoot, newRange.startContainer, newRange.startOffset);
			}
			else {
				count = 0;
			}
		}
		else {
			count = getCount(this._iframeDocument.body, range.startContainer, range.startOffset);
		}
		let countString = String(count).padStart(SORT_INDEX_LENGTH, '0');
		if (countString.length > SORT_INDEX_LENGTH) {
			countString = countString.substring(0, SORT_INDEX_LENGTH);
		}
		return countString;
	}

	/**
	 * Create text annotation at a specific position
	 */
	private _createTextAnnotation(position: { x: number; y: number }): NewAnnotation<WADMAnnotation> | null {
		const fontSize = (this._tool as any).size || 16;
		const rect = [
			position.x - fontSize / 2,
			position.y - fontSize / 2,
			position.x + fontSize / 2,
			position.y + fontSize / 2
		];

		// Create a range for the selector (use body as anchor since text annotations are absolutely positioned)
		const range = this._iframeDocument.createRange();
		range.selectNode(this._iframeDocument.body);

		const selector = this.toSelector(range);
		if (!selector) {
			return null;
		}

		// Calculate sort index
		const sortIndex = this._getSortIndex(range);

		// Store position data INSIDE the position object so it gets persisted to annotationPosition
		const positionWithData = {
			...selector,
			rects: [rect],
			fontSize,
			rotation: 0
		};

		const annotation: any = {
			type: 'text' as AnnotationType,
			color: this._tool.color,
			sortIndex,
			position: positionWithData
		};

		// Also store as _positionData for immediate rendering
		annotation._positionData = {
			rects: [rect],
			fontSize,
			rotation: 0
		};

		return annotation;
	}

	/**
	 * Create image annotation with rectangle
	 */
	private _createImageAnnotation(params: { startX: number; startY: number; endX: number; endY: number }): NewAnnotation<WADMAnnotation> | null {
		const { startX, startY, endX, endY } = params;
		const rect = [
			Math.min(startX, endX),
			Math.min(startY, endY),
			Math.max(startX, endX),
			Math.max(startY, endY)
		];

		// Create a range for the selector (use body as anchor)
		const range = this._iframeDocument.createRange();
		range.selectNode(this._iframeDocument.body);
		const selector = this.toSelector(range);
		if (!selector) {
			return null;
		}

		// Calculate sort index based on position
		const sortIndex = String(Math.floor(rect[1])).padStart(SORT_INDEX_LENGTH, '0');

		// Store position data INSIDE the position object so it gets persisted
		const positionWithData = {
			...selector,
			rects: [rect]
		};

		const annotation: any = {
			type: 'image' as AnnotationType,
			color: this._tool.color,
			sortIndex,
			position: positionWithData
		};

		// Also store as _positionData for immediate rendering
		annotation._positionData = {
			rects: [rect]
		};

		return annotation;
	}

	/**
	 * Create ink annotation with path
	 */
	private _createInkAnnotation(action: { paths?: number[][] }): NewAnnotation<WADMAnnotation> | null {
		if (!action.paths || action.paths[0].length < 2) {
			return null;
		}

		// Create a range for the selector (use body as anchor)
		const range = this._iframeDocument.createRange();
		range.selectNode(this._iframeDocument.body);
		const selector = this.toSelector(range);
		if (!selector) {
			return null;
		}

		// Calculate sort index based on first point
		const sortIndex = String(Math.floor(action.paths[0][1])).padStart(SORT_INDEX_LENGTH, '0');

		// Store position data INSIDE the position object so it gets persisted
		const positionWithData = {
			...selector,
			paths: action.paths,
			width: (this._tool as any).size || 2
		};

		const annotation: any = {
			type: 'ink' as AnnotationType,
			color: this._tool.color,
			sortIndex,
			position: positionWithData
		};

		// Also store as _positionData for immediate rendering
		annotation._positionData = {
			paths: action.paths,
			width: (this._tool as any).size || 2
		};

		return annotation;
	}

	toSelector(range: Range): Selector | null {
		if (this._focusMode.enabled) {
			let newRange = this._focusMode.mapRangeFromFocus(range);
			if (!newRange) {
				return null;
			}
			range = newRange;
		}

		let doc = range.commonAncestorContainer.ownerDocument;
		if (!doc) return null;
		let targetNode;
		// In most cases, the range will wrap a single child of the
		// commonAncestorContainer. Build a selector targeting that element,
		// not the container.
		if (range.startContainer === range.endContainer
				&& range.startOffset == range.endOffset - 1
				&& range.startContainer.nodeType == Node.ELEMENT_NODE) {
			targetNode = range.startContainer.childNodes[range.startOffset];
		}
		else {
			targetNode = range.commonAncestorContainer;
		}
		let targetElement = closestElement(targetNode);
		if (!targetElement) {
			return null;
		}
		let targetElementQuery = getUniqueSelectorContaining(targetElement);
		if (targetElementQuery) {
			let selector: CssSelector = {
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

	toDisplayedRange(selector: Selector): Range | null {
		switch (selector.type) {
			case 'CssSelector': {
				if (selector.refinedBy && selector.refinedBy.type != 'TextPositionSelector') {
					throw new Error('CssSelectors can only be refined by TextPositionSelectors');
				}
				let root = (this._focusMode.enabled ? this._focusMode.originalRoot : this._iframeDocument)
					.querySelector(selector.value);
				if (!root) {
					console.error(`Unable to locate selector root for selector '${selector.value}' (focus mode: ${this._focusMode.enabled})`);
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
				if (this._focusMode.enabled) {
					let newRange = this._focusMode.mapRangeToFocus(range);
					if (!newRange) {
						return null;
					}
					range = newRange;
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

	protected _getHistoryLocation(): NavLocation | null {
		return { scrollCoords: [this._iframeWindow.scrollX, this._iframeWindow.scrollY] };
	}

	protected _navigateToSelector(selector: Selector, options: NavigateOptions = {}) {
		let range = this.toDisplayedRange(selector);
		if (!range) {
			// Suppress log when failure is likely just due to focus mode
			if (!this._focusMode.enabled) {
				console.warn('Unable to resolve selector to range', selector);
			}
			return;
		}
		let elem = getStartElement(range);
		if (elem) {
			elem.scrollIntoView(options);
			// Remember which node was navigated to for screen readers to place
			// virtual cursor on it later. Used for navigating between sections in the outline.
			debounceUntilScrollFinishes(this._iframeDocument).then(() => {
				this._a11yVirtualCursorTarget = elem;
			});
		}

		if (options.ifNeeded && isPageRectVisible(getBoundingPageRect(range), this._iframeWindow, 0)) {
			return;
		}

		scrollIntoView(range, options);
	}

	protected override _updateViewState() {
		let scale = Math.round(this.scale * 1000) / 1000; // Three decimal places
		let scrollYPercent = this._iframeWindow.scrollY
			/ (this._iframeDocument.body.scrollHeight - this._iframeDocument.documentElement.clientHeight)
			* 100;
		// The calculation above shouldn't ever yield NaN, but just to be safe:
		if (isNaN(scrollYPercent)) {
			scrollYPercent = 0;
		}
		// Keep it within [0, 100]
		scrollYPercent = Math.max(0, Math.min(100, scrollYPercent));
		scrollYPercent = Math.round(scrollYPercent * 10) / 10; // One decimal place
		let viewState: SnapshotViewState = {
			scale,
			scrollYPercent,
			appearance: this.appearance,
		};
		this._options.onChangeViewState(viewState);
	}

	protected override _updateViewStats() {
		let viewStats: ViewStats = {
			canCopy: !!this._selectedAnnotationIDs.length || !(this._iframeWindow.getSelection()?.isCollapsed ?? true),
			canZoomIn: this.scale === undefined || this.scale < this.MAX_SCALE,
			canZoomOut: this.scale === undefined || this.scale > this.MIN_SCALE,
			canZoomReset: this.scale !== undefined && this.scale !== 1,
			canNavigateBack: this._history.canNavigateBack,
			canNavigateForward: this._history.canNavigateForward,
			appearance: this.appearance,
			focusModeEnabled: this._focusMode.enabled,
		};
		this._options.onChangeViewStats(viewStats);
	}

	protected override _updateColorScheme() {
		super._updateColorScheme();
		if (this._isDynamicThemeSupported || this._focusMode.enabled) {
			// Pages with a reasonable amount of CSS: Use Dark Reader
			this._iframeDocument.body.classList.remove('force-static-theme');
			if (!('DarkReader' in this._iframeWindow)) {
				let url = this._getSnapshotLocation() || 'about:blank';
				// Dark Reader gets the page location by accessing the global property 'location'
				// Horrifying, but it works
				this._iframeWindow.eval(`{ let location = new URL(${JSON.stringify(url)}); ${darkReaderJS} }`);
			}
			let DarkReader = this._iframeWindow.DarkReader!;
			// Stock light theme: Just let the page use its default styles
			if (this._themeColorScheme === 'light' && this._theme.id === 'light') {
				DarkReader.disable();
			}
			else {
				DarkReader.enable({
					mode: this._themeColorScheme === 'light' ? 0 : 1,
					darkSchemeBackgroundColor: this._theme.background,
					darkSchemeTextColor: this._theme.foreground,
					lightSchemeBackgroundColor: this._theme.background,
					lightSchemeTextColor: this._theme.foreground,
				}, {
					invert: [
						// Invert Mediawiki equations
						'.mw-invert'
					]
				} satisfies Partial<DynamicThemeFix> as DynamicThemeFix);
			}
		}
		else {
			// Pages with a *lot* of CSS: Use static theme
			if ('DarkReader' in this._iframeWindow) {
				this._iframeWindow.DarkReader!.disable();
			}
			this._iframeDocument.body.classList.toggle('force-static-theme', this._theme?.id !== 'light');
		}
	}

	// ***
	// Event handlers
	// ***

	protected _handleInternalLinkClick(link: HTMLAnchorElement): void {
		this._iframeDocument.location.hash = link.getAttribute('href')!;
		this._updateViewState();
	}

	protected override _handleScroll(event: Event) {
		super._handleScroll(event);
		this._updateViewState();
		this._pushHistoryPoint(true);
	}

	protected _handleVisibilityChange() {
		if (this._iframeDocument.visibilityState !== 'visible') {
			return;
		}
		this._handleViewUpdate();
	}

	// Override pointer event handlers to support text/image/ink tools
	protected override _handlePointerDown(event: PointerEvent) {
		// Call parent implementation first
		super._handlePointerDown(event);

		// Handle text/image/ink tools
		if ((event.buttons & 1) === 1 && event.isPrimary) {
			if (this._tool.type === 'text' || this._tool.type === 'image' || this._tool.type === 'ink') {
				// Check if we're clicking on an existing annotation
				// If so, don't start creating a new one - let selection happen instead
				const annotationIDs = this._annotationShadowRoot?.elementsFromPoint(event.clientX, event.clientY)
					.map(target => target.getAttribute('data-annotation-id'))
					.filter(Boolean) ?? [];
				if (annotationIDs.length > 0) {
					return;
				}

				// Store pointer down position in document coordinates
				this._pointerDownPosition = {
					x: event.clientX + this._iframeWindow.scrollX,
					y: event.clientY + this._iframeWindow.scrollY
				};

				if (this._tool.type === 'ink') {
					// Start ink annotation immediately
					this._annotationAction = {
						type: 'ink',
						paths: [[this._pointerDownPosition.x, this._pointerDownPosition.y]]
					};
					this._previewAnnotation = this._createInkAnnotation(this._annotationAction);
					this._renderAnnotations();
				}
				else if (this._tool.type === 'text') {
					// Start text annotation
					this._annotationAction = {
						type: 'text',
						startX: this._pointerDownPosition.x,
						startY: this._pointerDownPosition.y
					};
				}
				else if (this._tool.type === 'image') {
					// Start image annotation
					this._annotationAction = {
						type: 'image',
						startX: this._pointerDownPosition.x,
						startY: this._pointerDownPosition.y
					};
				}

				event.preventDefault();
			}
		}
	}

	protected override _handlePointerMove(event: PointerEvent) {
		// Call parent implementation first
		super._handlePointerMove(event);

		// Handle text/image/ink tools
		if ((event.buttons & 1) === 1 && event.isPrimary && this._annotationAction) {
			// Get current position in document coordinates
			const currentX = event.clientX + this._iframeWindow.scrollX;
			const currentY = event.clientY + this._iframeWindow.scrollY;

			if (this._annotationAction.type === 'ink' && this._annotationAction.paths) {
				// Add point to ink path
				this._annotationAction.paths[0].push(currentX, currentY);
				this._previewAnnotation = this._createInkAnnotation(this._annotationAction);
				this._renderAnnotations();
			}
			else if (this._annotationAction.type === 'image') {
				// Update image rectangle
				const imageParams = {
					startX: this._annotationAction.startX!,
					startY: this._annotationAction.startY!,
					endX: currentX,
					endY: currentY
				};
				this._previewAnnotation = this._createImageAnnotation(imageParams);
				this._renderAnnotations();
			}
			// Text annotations are created on pointer up
		}
	}

	protected override _handlePointerUp(event: PointerEvent) {
		// Call parent implementation first
		super._handlePointerUp(event);

		// Handle text/image/ink tools
		if (event.isPrimary && this._annotationAction) {
			if (this._annotationAction.type === 'text') {
				// Create text annotation at click position
				if (this._pointerDownPosition) {
					const annotation = this._createTextAnnotation(this._pointerDownPosition);
					if (annotation) {
						const addedAnnotation = this._options.onAddAnnotation(annotation, true);
						// Select the annotation and open popup
						if (addedAnnotation?.id) {
							this._options.onSelectAnnotations([addedAnnotation.id], event);
							this._renderAnnotations(true);
							this._openAnnotationPopup(addedAnnotation);
						}
						else {
							this._openAnnotationPopup();
						}
					}
				}
			}
			else if (this._annotationAction.type === 'image') {
				// Create image annotation if rectangle is large enough
				if (this._previewAnnotation) {
					const rect = (this._previewAnnotation as any)._positionData?.rects?.[0];
					if (rect && Math.abs(rect[2] - rect[0]) > 10 && Math.abs(rect[3] - rect[1]) > 10) {
						this._options.onAddAnnotation(this._previewAnnotation, true);
					}
					this._previewAnnotation = null;
					this._renderAnnotations();
				}
			}
			else if (this._annotationAction.type === 'ink') {
				// Create ink annotation if path has enough points
				if (this._previewAnnotation && this._annotationAction.paths) {
					const pathLength = this._annotationAction.paths[0].length;
					if (pathLength >= 4) {
						this._options.onAddAnnotation(this._previewAnnotation, true);
					}
				}
				this._previewAnnotation = null;
				this._renderAnnotations();
			}

			// Reset action state
			this._annotationAction = null;
			this._pointerDownPosition = null;
		}
	}

	// Override _openAnnotationPopup to handle text/image/ink annotations with absolute positioning
	protected override _openAnnotationPopup(annotation?: WADMAnnotation) {
		if (!annotation) {
			if (this._selectedAnnotationIDs.length !== 1) {
				return;
			}
			annotation = this._annotationsByID.get(this._selectedAnnotationIDs[0]);
			if (!annotation) {
				return;
			}
		}

		// For text/image/ink annotations, find the rendered element and get its bounding rect
		// This mirrors how 'note' annotations are handled in DOMView._openAnnotationPopup
		if (annotation.type === 'text' || annotation.type === 'image' || annotation.type === 'ink') {
			const annotationElem = this._annotationRenderRootEl?.querySelector(`[data-annotation-id="${annotation.id}"]`);
			if (annotationElem) {
				// Only scale the rect (same as note annotations) - don't double-transform
				const domRect = this._scaleDOMRect(annotationElem.getBoundingClientRect());
				const popupRect: [number, number, number, number] = [
					domRect.left,
					domRect.top,
					domRect.right,
					domRect.bottom
				];
				this._options.onSetAnnotationPopup({ rect: popupRect, annotation });
				return;
			}
		}

		// For other annotation types, use parent implementation
		super._openAnnotationPopup(annotation);
	}


	// ***
	// Setters that get called once there are changes in reader._state
	// ***

	// Unlike annotation, selection and overlay popups, find popup open state is determined
	// with .open property. All popup properties are preserved even when it's closed
	async setFindState(state: FindState) {
		let previousState = this._findState;
		this._findState = state;
		if (!state.active && previousState && previousState.active !== state.active) {
			console.log('Closing find popup');
			if (this._find) {
				this._find = null;
				this._handleViewUpdate();
			}
		}
		else if (state.active) {
			if (!previousState
				|| previousState.query !== state.query
				|| previousState.caseSensitive !== state.caseSensitive
				|| previousState.entireWord !== state.entireWord
				|| previousState.active !== state.active) {
				console.log('Initiating new search', state);
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
						if (result.range) {
							// Record the result that screen readers should focus on after search popup is closed
							this._a11yVirtualCursorTarget = getStartElement(result.range);
						}
					},
				});
				await this._find.run(
					this._searchContext,
					this._lastSelectionRange ?? undefined
				);
				this.findNext();
			}
			else if (previousState && previousState.highlightAll !== state.highlightAll) {
				this._find!.findState.highlightAll = state.highlightAll;
				this._renderAnnotations();
			}
		}
	}

	// ***
	// Public methods to control the view from the outside
	// ***

	findNext() {
		console.log('Find next');
		if (this._find) {
			let result = this._find.next();
			if (result) {
				scrollIntoView(result.range.toRange(), { block: 'start' });
			}
			this._renderAnnotations();
		}
	}

	findPrevious() {
		console.log('Find previous');
		if (this._find) {
			let result = this._find.prev();
			if (result) {
				scrollIntoView(result.range.toRange(), { block: 'start' });
			}
			this._renderAnnotations();
		}
	}

	protected _setScale(scale: number) {
		this.scale = scale;

		if (this._options.onSetZoom) {
			this._options.onSetZoom(this._iframe, scale);
			// Store the scale factor so we can adjust clientX/clientY coordinates when opening popups
			// TODO: Use CSS zoom instead of onSetZoom() when Zotero is on fx>=126
			this._iframeCoordScaleFactor = scale;
		}
		else {
			if (scale == 1) {
				this._iframeDocument.documentElement.style.fontSize = '';
				return;
			}

			// Calculate the default root font size, then multiply by scale.
			// Can't just set font-size to an em value -- the page itself might set a font-size on <html>, and we need to
			// scale relative to that.
			this._iframeDocument.documentElement.style.fontSize = '';
			let defaultSize = parseFloat(getComputedStyle(this._iframeDocument.documentElement).fontSize);
			this._iframeDocument.documentElement.style.fontSize = (defaultSize * scale) + 'px';
		}
	}

	override navigate(location: NavLocation, options: NavigateOptions = {}) {
		console.log('Navigating to', location);
		options.behavior ||= 'smooth';

		if (location.scrollCoords) {
			this._iframeWindow.scrollTo(...location.scrollCoords);
		}
		else {
			super.navigate(location, options);
		}

		if (!options.skipHistory) {
			this._pushHistoryPoint();
		}
	}

	async print() {
		if (typeof this._iframeWindow.zoteroPrint === 'function') {
			await this._iframeWindow.zoteroPrint({
				overrideSettings: {
					docURL: this._options.data.importedFromURL || '',
				},
			});
		}
		else {
			this._iframeWindow.print();
		}
	}

	setSidebarOpen(_sidebarOpen: boolean) {
		// Ignore
	}

	setFocusModeEnabled(enabled: boolean) {
		this._focusMode.enabled = enabled;
		// Hide inaccessible annotations
		if (enabled) {
			this._options.onSetHiddenAnnotations(
				this._annotations
					.filter(a => !this.toDisplayedRange(a.position))
					.map(a => a.id)
			);
		}
		else {
			this._options.onSetHiddenAnnotations([]);
		}
		// Reinitialize outline to remove inaccessible sections
		this._initOutline();
		this._handleViewUpdate();
	}
}

export interface SnapshotViewState extends DOMViewState {
	scrollYPercent?: number;
}

export interface SnapshotViewData {
	srcDoc?: string;
	url?: string;
	importedFromURL?: string;
}

export default SnapshotView;
