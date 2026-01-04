import React, {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState
} from 'react';
import {
	caretPositionFromPoint,
	collapseToOneCharacterAtStart,
	getBoundingPageRect,
	getColumnSeparatedPageRects,
	getPageRects,
	splitRangeToTextNodes,
	supportsCaretPositionFromPoint
} from "../../lib/range";
import { AnnotationType } from "../../../../common/types";
// @ts-ignore - react-dom types issue
import * as ReactDOM from "react-dom";
import { IconNoteLarge } from "../../../../common/components/common/icons";
import { closestElement, isRTL, isVertical } from "../../lib/nodes";
import { isSafari } from "../../../../common/lib/utilities";
import { expandRect, getBoundingRect, rectsEqual } from "../../lib/rect";
// @ts-ignore - classnames doesn't have type definitions but is used throughout the codebase
import cx from "classnames";

export type DisplayedAnnotation = {
	id?: string;
	sourceID?: string;
	type: AnnotationType;
	color?: string;
	sortIndex?: string;
	text?: string;
	comment?: string;
	readOnly?: boolean;
	key: string;
	range: Range;
};

export const AnnotationOverlay: React.FC<AnnotationOverlayProps> = (props) => {
	let { iframe, annotations, selectedAnnotationIDs, onPointerDown, onPointerUp, onContextMenu, onDragStart, onResizeStart, onResizeEnd, onTextChange } = props;
	
	// Store onTextChange in a ref to ensure it's always available in closures
	// Initialize with current value and update immediately if it changes
	const onTextChangeRef = React.useRef(onTextChange);
	// Update ref immediately (not just in effect) to ensure it's always current
	if (onTextChangeRef.current !== onTextChange) {
		onTextChangeRef.current = onTextChange;
	}
	React.useEffect(() => {
		onTextChangeRef.current = onTextChange;
	}, [onTextChange]);
	
	// Debug log for onTextChange prop
	console.log('[AnnotationOverlay] AnnotationOverlay rendered with onTextChange:', {
		hasOnTextChange: !!onTextChange,
		hasOnTextChangeRef: !!onTextChangeRef.current,
		onTextChangeType: typeof onTextChange,
		onTextChangeValue: onTextChange,
		onTextChangeInProps: 'onTextChange' in props,
		propsOnTextChange: (props as any).onTextChange,
		propsOnTextChangeType: typeof (props as any).onTextChange,
		propsKeys: Object.keys(props),
		propsKeysList: Object.keys(props).join(', ')
	});
	
	// Debug log for onTextChange prop
	console.log('[AnnotationOverlay] AnnotationOverlay rendered with onTextChange:', {
		hasOnTextChange: !!onTextChange,
		hasOnTextChangeRef: !!onTextChangeRef.current,
		onTextChangeType: typeof onTextChange,
		onTextChangeValue: onTextChange,
		onTextChangeInProps: 'onTextChange' in props,
		propsOnTextChange: (props as any).onTextChange,
		propsOnTextChangeType: typeof (props as any).onTextChange,
		propsKeys: Object.keys(props),
		propsKeysList: Object.keys(props).join(', ')
	});

	let [isResizing, setResizing] = useState(false);
	let [isPointerDownOutside, setPointerDownOutside] = useState(false);
	let [isAltDown, setAltDown] = useState(false);
	let pointerEventsSuppressed = isResizing || isPointerDownOutside || isAltDown;

	useEffect(() => {
		const win = iframe.contentWindow;
		if (!win) {
			return undefined;
		}

		let handleWindowPointerDown = (event: PointerEvent) => {
			setAltDown(event.altKey);
			if (event.button == 0 && !(event.composedPath()[0] as Element).closest('.annotation-container')) {
				setPointerDownOutside(true);
			}
		};

		let handleWindowPointerUp = (event: PointerEvent) => {
			setAltDown(event.altKey);
			if (event.button == 0) {
				setPointerDownOutside(false);
			}
		};

		let handleWindowKeyDownCapture = (event: KeyboardEvent) => {
			if (event.key == 'Alt') {
				setAltDown(true);
			}
		};

		let handleWindowKeyUpCapture = (event: KeyboardEvent) => {
			if (event.key == 'Alt') {
				setAltDown(false);
			}
		};

		win.addEventListener('pointerdown', handleWindowPointerDown, { passive: true });
		win.addEventListener('pointerup', handleWindowPointerUp, { passive: true });
		// Listen for Alt on the iframe window and the root window, because the iframe window doesn't get the event
		// when an annotation text field is focused
		win.addEventListener('keydown', handleWindowKeyDownCapture, { capture: true, passive: true });
		win.addEventListener('keyup', handleWindowKeyUpCapture, { capture: true, passive: true });
		window.addEventListener('keydown', handleWindowKeyDownCapture, { capture: true, passive: true });
		window.addEventListener('keyup', handleWindowKeyUpCapture, { capture: true, passive: true });
		return () => {
			win.removeEventListener('pointerdown', handleWindowPointerDown);
			win.removeEventListener('pointerup', handleWindowPointerUp);
			win.removeEventListener('keydown', handleWindowKeyDownCapture, { capture: true });
			win.removeEventListener('keyup', handleWindowKeyUpCapture, { capture: true });
			window.removeEventListener('keydown', handleWindowKeyDownCapture, { capture: true });
			window.removeEventListener('keyup', handleWindowKeyUpCapture, { capture: true });
		};
	}, [iframe.contentWindow]);

	let handlePointerDown = useCallback((annotation: DisplayedAnnotation, event: React.PointerEvent) => {
		onPointerDown(annotation.id!, event);
	}, [onPointerDown]);

	let handlePointerUp = useCallback((annotation: DisplayedAnnotation, event: React.PointerEvent) => {
		onPointerUp(annotation.id!, event);
	}, [onPointerUp]);

	let handleContextMenu = useCallback((annotation: DisplayedAnnotation, event: React.MouseEvent) => {
		onContextMenu(annotation.id!, event);
	}, [onContextMenu]);

	let handleDragStart = useCallback((annotation: DisplayedAnnotation, dataTransfer: DataTransfer) => {
		onDragStart(annotation.id!, dataTransfer);
	}, [onDragStart]);

	let handleResizeStart = useCallback((annotation: DisplayedAnnotation) => {
		setResizing(true);
		onResizeStart(annotation.id!);
	}, [onResizeStart]);

	let handleResizeEnd = useCallback((annotation: DisplayedAnnotation, range: Range, cancelled: boolean) => {
		setResizing(false);
		onResizeEnd(annotation.id!, range, cancelled);
	}, [onResizeEnd]);

	let widgetContainer = useRef<SVGSVGElement>(null);

	let highlightUnderlines: DisplayedAnnotation[] = [];
	let numSelectedHighlightUnderlines = 0;
	let notes: DisplayedAnnotation[] = [];
	let notePreviews: DisplayedAnnotation[] = [];
	let textAnnotations: DisplayedAnnotation[] = [];
	let imageAnnotations: DisplayedAnnotation[] = [];
	let inkAnnotations: DisplayedAnnotation[] = [];
	for (let annotation of annotations) {
		if (annotation.type === 'highlight' || annotation.type === 'underline') {
			// Put selected highlights/underlines at the end of the array,
			// so they render on top
			if (annotation.id && selectedAnnotationIDs.includes(annotation.id)) {
				highlightUnderlines.push(annotation);
				numSelectedHighlightUnderlines++;
			}
			else {
				highlightUnderlines.splice(
					highlightUnderlines.length - numSelectedHighlightUnderlines,
					0,
					annotation
				);
			}
		}
		else if (annotation.type == 'note') {
			if (annotation.id) {
				notes.push(annotation);
			}
			else {
				notePreviews.push(annotation);
			}
		}
		else if (annotation.type === 'text') {
			textAnnotations.push(annotation);
		}
		else if (annotation.type === 'image') {
			imageAnnotations.push(annotation);
		}
		else if (annotation.type === 'ink') {
			inkAnnotations.push(annotation);
		}
	}

	return <>
		<svg className={cx('annotation-container blended', { 'disable-pointer-events': pointerEventsSuppressed })}>
			{highlightUnderlines.map((annotation) => {
				if (annotation.id) {
					return (
						<HighlightOrUnderline
							annotation={annotation}
							key={annotation.key}
							selected={selectedAnnotationIDs.includes(annotation.id)}
							singleSelection={selectedAnnotationIDs.length == 1}
							onPointerDown={handlePointerDown}
							onPointerUp={handlePointerUp}
							onContextMenu={handleContextMenu}
							onDragStart={handleDragStart}
							onResizeStart={handleResizeStart}
							onResizeEnd={handleResizeEnd}
							widgetContainer={widgetContainer.current}
						/>
					);
				}
				else {
					return (
						<g className="disable-pointer-events" key={annotation.key}>
							<HighlightOrUnderline
								annotation={annotation}
								selected={false}
								singleSelection={false}
								widgetContainer={widgetContainer.current}
							/>
						</g>
					);
				}
			})}
			{notePreviews.map(annotation => (
				<NotePreview annotation={annotation} key={annotation.key} />
			))}
			{textAnnotations.map(annotation => {
					// Use ref to get the latest onTextChange, with fallback to prop
				// Ensure we always pass a function (even if it's a no-op) to avoid undefined issues
					const textChangeHandler = onTextChangeRef.current || onTextChange;
				const safeTextChangeHandler = typeof textChangeHandler === 'function' 
					? textChangeHandler 
					: ((id: string, text: string) => {
						console.warn('[AnnotationOverlay] onTextChange is not a function, text changes will not be saved', {
							annotationId: id,
						hasOnTextChange: !!onTextChange,
						hasOnTextChangeRef: !!onTextChangeRef.current,
							hasTextChangeHandler: !!textChangeHandler
						});
					});
				console.log('[AnnotationOverlay] Rendering TextAnnotation:', {
					annotationId: annotation.id,
					pointerEventsSuppressed: pointerEventsSuppressed,
					isResizing: isResizing,
					isPointerDownOutside: isPointerDownOutside,
					isAltDown: isAltDown,
					hasOnPointerDown: !!handlePointerDown
					});
					return (
						<TextAnnotation
							annotation={annotation}
							key={annotation.key}
							iframe={iframe}
							selected={annotation.id ? selectedAnnotationIDs.includes(annotation.id) : false}
							onPointerDown={annotation.id ? handlePointerDown : undefined}
							onPointerUp={annotation.id ? handlePointerUp : undefined}
							onContextMenu={annotation.id ? handleContextMenu : undefined}
						onTextChange={safeTextChangeHandler}
						/>
					);
			})}
			{imageAnnotations.map(annotation => (
				<ImageAnnotation
					annotation={annotation}
					key={annotation.key}
					selected={annotation.id ? selectedAnnotationIDs.includes(annotation.id) : false}
					onPointerDown={annotation.id ? handlePointerDown : undefined}
					onPointerUp={annotation.id ? handlePointerUp : undefined}
					onContextMenu={annotation.id ? handleContextMenu : undefined}
				/>
			))}
			{inkAnnotations.map(annotation => (
				<InkAnnotation
					annotation={annotation}
					key={annotation.key}
					selected={annotation.id ? selectedAnnotationIDs.includes(annotation.id) : false}
					onPointerDown={annotation.id ? handlePointerDown : undefined}
					onPointerUp={annotation.id ? handlePointerUp : undefined}
					onContextMenu={annotation.id ? handleContextMenu : undefined}
				/>
			))}
		</svg>
		<svg
			className={cx('annotation-container', { 'disable-pointer-events': pointerEventsSuppressed })}
			ref={widgetContainer}
		>
			<StaggeredNotes
				annotations={notes}
				selectedAnnotationIDs={selectedAnnotationIDs}
				onPointerDown={handlePointerDown}
				onPointerUp={handlePointerUp}
				onContextMenu={handleContextMenu}
				onDragStart={handleDragStart}
			/>
		</svg>
	</>;
};
AnnotationOverlay.displayName = 'AnnotationOverlay';

// Text annotation component
let TextAnnotation: React.FC<TextAnnotationProps> = (props) => {
	let { annotation, selected, onPointerDown, onPointerUp, onContextMenu, iframe, onTextChange } = props;
	
	// Debug log to see what we're receiving
	console.log('[TextAnnotation] TextAnnotation rendered with props:', {
		annotationId: annotation.id,
		hasOnTextChange: !!onTextChange,
		onTextChangeType: typeof onTextChange,
		onTextChangeValue: onTextChange,
		propsKeys: Object.keys(props),
		onTextChangeInProps: 'onTextChange' in props
	});
	
	// Store onTextChange in a ref to avoid closure issues with React.memo
	// Initialize with the current prop value
	const onTextChangeRef = React.useRef(onTextChange);
	
	// Always update ref to latest value (even if memo prevents re-render)
	// This ensures we always have the latest callback
	if (onTextChangeRef.current !== onTextChange) {
		onTextChangeRef.current = onTextChange;
	}
	
	React.useEffect(() => {
		onTextChangeRef.current = onTextChange;
		console.log('[TextAnnotation] onTextChange ref updated in useEffect:', {
		annotationId: annotation.id,
		hasOnTextChange: !!onTextChange,
			hasRefCurrent: !!onTextChangeRef.current
		});
	}, [onTextChange, annotation.id]);
	
	// Use ref to track the textarea element (like PDF does with DOM nodes)
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const foreignObjectRef = useRef<SVGForeignObjectElement>(null);
	// Use local state to store the current value and prevent cursor position resets
	// This matches PDF's approach of only updating the DOM value when it differs
	const [localValue, setLocalValue] = useState<string>(annotation.comment || '');
	const [isHovered, setIsHovered] = useState(false);
	const [dynamicDimensions, setDynamicDimensions] = useState<{ width: number; height: number } | null>(null);
	const lastPropValueRef = useRef<string>(annotation.comment || '');
	const lastAnnotationIdRef = useRef<string | undefined>(annotation.id);
	// Auto-focus when annotation is newly created (empty comment)
	const shouldAutoFocusRef = useRef<boolean>(!annotation.comment || annotation.comment === '');
	
	// Reset state when annotation ID changes (new annotation created)
	useEffect(() => {
		if (annotation.id !== lastAnnotationIdRef.current) {
			lastAnnotationIdRef.current = annotation.id;
			const newComment = annotation.comment || '';
			shouldAutoFocusRef.current = !newComment || newComment === '';
			lastPropValueRef.current = newComment;
			setLocalValue(newComment);
		}
	}, [annotation.id, annotation.comment]);
	
	// Get position data from annotation
	const positionData = (annotation as any)._positionData;
	if (!positionData || !positionData.rects || !positionData.rects[0]) {
		return null;
	}
	
	const rect = positionData.rects[0];
	
	// Get document from iframe instead of range (range might be from temporary element)
	const doc = iframe?.contentDocument;
	if (!doc || !doc.defaultView) {
		return null;
	}
	
	// Use getBoundingPageRect to convert range to page coordinates (like other annotations)
	// But since we have absolute coordinates, we can use them directly
	// The rect coordinates are already in document/page coordinates
	const pageRect = {
		x: rect[0],
		y: rect[1],
		width: rect[2] - rect[0],
		height: rect[3] - rect[1]
	};
	
	// Sync prop value to local state only when it changes externally (like PDF checks data-comment attribute)
	// This prevents cursor position resets during typing
	useEffect(() => {
		const propValue = annotation.comment || '';
		// Skip if we're already syncing due to ID change
		if (propValue === lastPropValueRef.current) {
			return;
		}
		// Only update if the prop value is actually different from what we have locally
		// and if the user isn't currently typing (textarea isn't focused)
		// Use iframe document to check active element
		const isFocused = doc?.activeElement === textareaRef.current;
		// CRITICAL: Don't sync if focused AND the prop value matches what we just saved
		// This prevents overwriting user input while typing
		if (!isFocused) {
			// Only sync when not focused - this allows external updates to come through
			if (propValue !== localValue) {
			lastPropValueRef.current = propValue;
			setLocalValue(propValue);
			}
		} else {
			// When focused, only update if the prop value is different AND we didn't just set it
			// This handles external updates while typing (shouldn't happen, but be safe)
			if (propValue !== lastPropValueRef.current && propValue !== localValue) {
				lastPropValueRef.current = propValue;
				setLocalValue(propValue);
			}
		}
	}, [annotation.comment, doc]); // Remove localValue from dependencies to prevent loop
	
	// Auto-focus when annotation is newly created (empty comment), like PDF behavior
	useEffect(() => {
		if (shouldAutoFocusRef.current && textareaRef.current && !annotation.readOnly) {
			// Use setTimeout to ensure the element is fully rendered and focusable
			setTimeout(() => {
				if (textareaRef.current) {
					textareaRef.current.focus();
					// Move cursor to end
					const len = textareaRef.current.value.length;
					textareaRef.current.setSelectionRange(len, len);
					shouldAutoFocusRef.current = false;
				}
			}, 0);
		}
	}, [annotation.id, annotation.readOnly]);
	
	// Add native event listeners to debug if events are reaching the textarea at all
	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		
		// Get the iframe window and document
		const iframeWindow = iframe.contentWindow;
		const iframeDocument = iframe.contentDocument;
		if (!iframeWindow || !iframeDocument) return;
		
		const handleNativeClick = (e: MouseEvent) => {
			console.log('[TextAnnotation] ===== NATIVE CLICK EVENT ON TEXTAREA =====', {
				annotationId: annotation.id,
				target: e.target,
				currentTarget: e.currentTarget,
				type: e.type
			});
		};
		
		const handleNativePointerDown = (e: PointerEvent) => {
			console.log('[TextAnnotation] ===== NATIVE POINTER DOWN ON TEXTAREA =====', {
				annotationId: annotation.id,
				target: e.target,
				currentTarget: e.currentTarget,
				type: e.type,
				pointerType: e.pointerType,
				button: e.button
			});
		};
		
		// Handle Delete/Backspace in capture phase to prevent parent from deleting annotation
		// when textarea is focused (has active cursor)
		// Listen on both textarea and iframe window to catch events early
		const handleNativeKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Delete' || e.key === 'Backspace') {
				// Check if textarea is focused (has active cursor)
				// Use iframe document's activeElement to check focus
				const isFocused = iframeDocument.activeElement === textarea 
					|| e.target === textarea 
					|| (e.target instanceof Element && e.target.closest('textarea') === textarea);
				
				console.log('[TextAnnotation.handleNativeKeyDown] Delete/Backspace pressed:', {
					annotationId: annotation.id,
					key: e.key,
					isFocused: isFocused,
					activeElement: iframeDocument.activeElement instanceof Element ? iframeDocument.activeElement.tagName : 'not Element',
					eventTarget: e.target instanceof Element ? e.target.tagName : 'not Element',
					textareaRef: !!textarea
				});
				
				if (isFocused) {
					// Textarea has focus - stop immediate propagation to prevent ALL other handlers (including keyboard manager)
					// Allow normal delete/backspace behavior in the textarea
					console.log('[TextAnnotation.handleNativeKeyDown] Textarea is focused - stopping immediate propagation, allowing normal delete');
					e.stopImmediatePropagation();
					e.stopPropagation();
		} else {
					// If not focused, don't stop propagation - let parent handle deletion
					console.log('[TextAnnotation.handleNativeKeyDown] Textarea is NOT focused - allowing propagation for annotation deletion');
				}
			}
		};
		
		textarea.addEventListener('click', handleNativeClick, true);
		textarea.addEventListener('pointerdown', handleNativePointerDown, true);
		// Use capture phase (true) to intercept before parent handler runs
		textarea.addEventListener('keydown', handleNativeKeyDown, true);
		
		// Also listen on iframe window in capture phase to catch events even earlier
		// This ensures we intercept before DOMView's _handleKeyDown runs
		iframeWindow.addEventListener('keydown', handleNativeKeyDown, true);
		
		return () => {
			textarea.removeEventListener('click', handleNativeClick, true);
			textarea.removeEventListener('pointerdown', handleNativePointerDown, true);
			textarea.removeEventListener('keydown', handleNativeKeyDown, true);
			iframeWindow.removeEventListener('keydown', handleNativeKeyDown, true);
		};
	}, [annotation.id, textareaRef.current, iframe]);
	
	const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
		const newValue = event.target.value;
		const oldValue = localValue;
		
		console.log('[TextAnnotation.handleInput] Keystroke detected:', {
			annotationId: annotation.id,
			oldValue: oldValue,
			newValue: newValue,
			valueLength: newValue.length,
			addedText: newValue.slice(oldValue.length),
			removedText: oldValue.slice(newValue.length),
			eventType: event.type,
			targetValue: event.target.value
		});
		
		// Update local state immediately for responsive typing
		setLocalValue(newValue);
		
		// Auto-resize textarea and foreignObject based on content
		const textarea = event.target;
		// Reset height to auto to get accurate scrollHeight
		textarea.style.height = 'auto';
		textarea.style.width = 'auto';
		
		const fontSize = positionData.fontSize || 16;
		const minWidth = fontSize;
		const minHeight = fontSize;
		
		// Measure the content
		const scrollHeight = Math.max(textarea.scrollHeight, minHeight);
		const scrollWidth = Math.max(
			textarea.scrollWidth || 0,
			pageRect.width || minWidth,
			newValue.length > 0 ? Math.min(newValue.length * (fontSize * 0.6), 300) : minWidth
		);
		
		// Update textarea dimensions
		textarea.style.height = scrollHeight + 'px';
		textarea.style.width = '100%';
		
		// Update foreignObject dimensions dynamically
		if (foreignObjectRef.current) {
			foreignObjectRef.current.setAttribute('width', String(scrollWidth));
			foreignObjectRef.current.setAttribute('height', String(scrollHeight));
		}
		
		// Store dynamic dimensions for render
		setDynamicDimensions({ width: scrollWidth, height: scrollHeight });
		
		// Update the annotation via callback (like PDF's _handleInput)
		// Use ref to get the latest callback (check both ref and prop as fallback)
		const textChangeCallback = onTextChangeRef.current || onTextChange;
		if (annotation.id && textChangeCallback) {
			// CRITICAL: Update lastPropValueRef when we save to prevent useEffect from syncing stale value back
			// This ensures that if the component re-renders before the prop updates, we don't lose the text
			lastPropValueRef.current = newValue;
			textChangeCallback(annotation.id, newValue);
		} else {
			if (!textChangeCallback) {
				console.warn('[TextAnnotation] Cannot call onTextChange - missing callback', {
					hasRef: !!onTextChangeRef.current,
					hasProp: !!onTextChange
				});
			}
		}
	};
	
	const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// Handle Escape key to blur (like PDF)
		if (event.key === 'Escape') {
			event.stopPropagation();
			event.preventDefault();
			event.currentTarget.blur();
		}
		// Delete/Backspace handling is done in native capture-phase listener
		// to prevent parent from deleting annotation when textarea is focused
		// Enter key should insert a newline (default behavior)
		// No need to prevent default or stop propagation
	};
	
	const handleFocus = () => {
		// Textarea focused - no action needed
	};
	
	const handleBlur = () => {
		const finalValue = textareaRef.current?.value || '';
		
		// Ensure final value is saved on blur (in case there were any last changes)
		// Use ref to get the latest callback (check both ref and prop as fallback)
		const textChangeCallback = onTextChangeRef.current || onTextChange;
		if (annotation.id && textChangeCallback) {
			// Update local state to match the actual textarea value
			if (finalValue !== localValue) {
				setLocalValue(finalValue);
			}
			
			// CRITICAL: Update lastPropValueRef BEFORE saving to prevent useEffect from syncing stale prop value back
			// This prevents the text from disappearing when the component re-renders after save
			lastPropValueRef.current = finalValue;
			
			// Always save the final value (this ensures it's persisted)
			textChangeCallback(annotation.id, finalValue);
		} else if (!textChangeCallback) {
			console.warn('[TextAnnotation] Cannot save on blur - missing onTextChange callback');
		}
	};
	
	
	// Calculate dimensions - use dynamic if set, otherwise use pageRect
	const fontSize = positionData.fontSize || 16;
	const minWidth = fontSize;
	const minHeight = fontSize;
	
	const displayWidth = dynamicDimensions?.width || Math.max(pageRect.width || minWidth, minWidth);
	const displayHeight = dynamicDimensions?.height || Math.max(pageRect.height || minHeight, minHeight);
	
	// Recalculate dimensions when pageRect changes (annotation position updated)
	useEffect(() => {
		// If pageRect dimensions changed, update dynamic dimensions
		if (pageRect.width > 0 && pageRect.height > 0) {
			// Reset dynamic dimensions to use pageRect when it updates
			// (This happens when annotation position is recalculated after text change)
			setDynamicDimensions(null);
		}
	}, [pageRect.width, pageRect.height]);
	
	// Initialize/recalculate dimensions based on content
	useEffect(() => {
		if (textareaRef.current) {
			const textarea = textareaRef.current;
			const currentValue = localValue || '';
			// Reset to measure
			textarea.style.height = 'auto';
			textarea.style.width = 'auto';
			
			const measuredHeight = Math.max(textarea.scrollHeight || minHeight, minHeight);
			const measuredWidth = Math.max(
				textarea.scrollWidth || 0,
				pageRect.width || minWidth,
				currentValue.length > 0 ? Math.min(currentValue.length * (fontSize * 0.6), 300) : minWidth
			);
			
			// Apply measured height
			textarea.style.height = measuredHeight + 'px';
			
			// Update foreignObject if it exists
			// Account for border width (2px or 3px) and padding (4px top/bottom, 6px left/right)
			// Since we're using border-box, the textarea width includes border, but foreignObject needs to match
			const borderWidth = selected ? 3 : 2; // Will be updated on hover, but use current state
			const paddingHorizontal = 6 * 2; // 6px left + 6px right
			const paddingVertical = 4 * 2; // 4px top + 4px bottom
			const borderTotal = borderWidth * 2; // left + right borders
			const borderTotalVertical = borderWidth * 2; // top + bottom borders
			
			// foreignObject width should match the total width including borders
			// Since textarea uses border-box, measuredWidth already includes border, but we need to ensure foreignObject is sized correctly
			if (foreignObjectRef.current) {
				// Set foreignObject to accommodate the full textarea including borders
				foreignObjectRef.current.setAttribute('width', String(measuredWidth));
				foreignObjectRef.current.setAttribute('height', String(measuredHeight));
			}
			
			// Store for render
			setDynamicDimensions({ width: measuredWidth, height: measuredHeight });
		}
	}, [localValue, annotation.id, fontSize, minWidth, minHeight, pageRect.width, pageRect.height]); // Recalculate when text or annotation changes
	
	console.log('[TextAnnotation] Rendering text annotation, checking pointer events:', {
		annotationId: annotation.id,
		readOnly: annotation.readOnly,
		hasTextareaRef: !!textareaRef.current,
		textareaValue: textareaRef.current?.value
	});
	
	return (
		<g
			data-annotation-id={annotation.id}
			style={{ pointerEvents: 'auto' }}
			onPointerDown={(event) => {
				// Only handle clicks on the border (wrapper div), not on textarea
				// Clicks inside textarea will naturally focus it
				const target = event.target as Element;
				const isTextarea = target.tagName === 'TEXTAREA' || target.closest('textarea');
				
				// If clicking on border (wrapper div), select annotation
				// If clicking inside textarea, let it focus naturally
				if (!isTextarea && onPointerDown) {
					onPointerDown(annotation, event);
				}
			}}
			onPointerUp={onPointerUp && (event => onPointerUp!(annotation, event))}
			onContextMenu={onContextMenu && (event => onContextMenu!(annotation, event))}
		>
			<foreignObject
				ref={foreignObjectRef}
				x={pageRect.x}
				y={pageRect.y}
				width={displayWidth}
				height={displayHeight}
				style={{ pointerEvents: 'auto', overflow: 'visible' }}
			>
				<div
					onMouseEnter={() => setIsHovered(true)}
					onMouseLeave={() => setIsHovered(false)}
					onPointerDown={(e: React.PointerEvent) => {
						// Clicking on border (wrapper div) - select annotation, don't focus textarea
						e.stopPropagation();
						if (onPointerDown) {
							onPointerDown(annotation, e);
						}
					}}
					style={{
						width: '100%',
						height: '100%',
						// Border on the wrapper div to ensure all sides are visible
						border: selected 
							? '3px solid #6d95e0' 
							: isHovered 
								? '3px solid rgba(0, 0, 0, 0.5)' 
								: '2px solid rgba(0, 0, 0, 0.3)',
						background: 'rgba(255, 255, 255, 0.95)',
						boxShadow: selected 
							? '0 2px 4px rgba(109, 149, 224, 0.3)' 
							: isHovered
								? '0 2px 4px rgba(0, 0, 0, 0.2)'
								: '0 1px 2px rgba(0, 0, 0, 0.1)',
						boxSizing: 'border-box',
						transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
						padding: 0,
						margin: 0
					}}
			>
				<textarea
					ref={textareaRef}
					value={localValue}
					onChange={handleInput}
					onKeyDown={handleKeyDown}
					onFocus={handleFocus}
					onBlur={handleBlur}
					onPointerDown={(e) => {
						// Clicking inside textarea - allow normal focus behavior
						// Stop propagation so border click handler doesn't interfere
						e.stopPropagation();
					}}
					style={{
						width: '100%',
						minWidth: `${minWidth}px`,
						height: '100%',
						minHeight: `${minHeight}px`,
						// No border on textarea - border is on wrapper div
						border: 'none',
						// Increased padding for larger clickable area
						padding: '4px 6px',
						fontSize: `${fontSize}px`,
						fontFamily: 'inherit',
						color: annotation.color || '#000000',
						// Transparent background - parent div has the background
						background: 'transparent',
						resize: 'none',
						overflow: 'hidden',
						overflowY: 'auto',
						whiteSpace: 'pre-wrap',
						wordWrap: 'break-word',
						outline: 'none',
						cursor: 'text',
						boxSizing: 'border-box',
						margin: 0
					}}
					placeholder="Text annotation"
					disabled={annotation.readOnly}
					dir="auto"
				/>
				</div>
			</foreignObject>
		</g>
	);
};
TextAnnotation.displayName = 'TextAnnotation';
// Don't memoize TextAnnotation - onTextChange prop needs to update reliably
// TextAnnotation = memo(TextAnnotation);
type TextAnnotationProps = {
	annotation: DisplayedAnnotation;
	iframe: HTMLIFrameElement;
	selected: boolean;
	onPointerDown?: (annotation: DisplayedAnnotation, event: React.PointerEvent) => void;
	onPointerUp?: (annotation: DisplayedAnnotation, event: React.PointerEvent) => void;
	onContextMenu?: (annotation: DisplayedAnnotation, event: React.MouseEvent) => void;
	onTextChange?: (id: string, text: string) => void;
};

// Image annotation component
let ImageAnnotation: React.FC<ImageAnnotationProps> = (props) => {
	let { annotation, selected, onPointerDown, onPointerUp, onContextMenu } = props;
	
	// Get position data from annotation
	const positionData = (annotation as any)._positionData;
	if (!positionData || !positionData.rects || !positionData.rects[0]) {
		return null;
	}
	
	const rect = positionData.rects[0];
	const doc = annotation.range.commonAncestorContainer.ownerDocument;
	if (!doc || !doc.defaultView) {
		return null;
	}
	
	// Convert to page coordinates
	const pageRect = {
		x: rect[0],
		y: rect[1],
		width: rect[2] - rect[0],
		height: rect[3] - rect[1]
	};
	
	return (
		<g
			data-annotation-id={annotation.id}
			style={{ pointerEvents: 'auto' }}
			onPointerDown={onPointerDown && (event => onPointerDown!(annotation, event))}
			onPointerUp={onPointerUp && (event => onPointerUp!(annotation, event))}
			onContextMenu={onContextMenu && (event => onContextMenu!(annotation, event))}
		>
			{/* Invisible thicker transparent stroke for easier clicking on border */}
			<rect
				x={pageRect.x}
				y={pageRect.y}
				width={pageRect.width}
				height={pageRect.height}
				fill="none"
				stroke="transparent"
				strokeWidth={Math.max(selected ? 8 : 6, 6)}
				pointerEvents="stroke"
			/>
			{/* Visible stroke */}
			<rect
				x={pageRect.x}
				y={pageRect.y}
				width={pageRect.width}
				height={pageRect.height}
				fill="none"
				stroke={annotation.color || '#000000'}
				strokeWidth={selected ? 3 : 2}
				opacity={selected ? 1 : 0.7}
				pointerEvents="none"
			/>
		</g>
	);
};
ImageAnnotation.displayName = 'ImageAnnotation';
ImageAnnotation = memo(ImageAnnotation);
type ImageAnnotationProps = {
	annotation: DisplayedAnnotation;
	selected: boolean;
	onPointerDown?: (annotation: DisplayedAnnotation, event: React.PointerEvent) => void;
	onPointerUp?: (annotation: DisplayedAnnotation, event: React.PointerEvent) => void;
	onContextMenu?: (annotation: DisplayedAnnotation, event: React.MouseEvent) => void;
};

// Ink annotation component
let InkAnnotation: React.FC<InkAnnotationProps> = (props) => {
	let { annotation, selected, onPointerDown, onPointerUp, onContextMenu } = props;
	
	// Get position data from annotation
	const positionData = (annotation as any)._positionData;
	if (!positionData || !positionData.paths || !positionData.paths[0] || positionData.paths[0].length < 4) {
		return null;
	}
	
	const path = positionData.paths[0];
	const width = positionData.width || 2;
	const doc = annotation.range.commonAncestorContainer.ownerDocument;
	if (!doc || !doc.defaultView) {
		return null;
	}
	
	// Build SVG path string
	let pathData = `M ${path[0]} ${path[1]}`;
	for (let i = 2; i < path.length; i += 2) {
		pathData += ` L ${path[i]} ${path[i + 1]}`;
	}
	
	return (
		<g
			data-annotation-id={annotation.id}
			style={{ pointerEvents: 'auto' }}
			onPointerDown={onPointerDown && (event => onPointerDown!(annotation, event))}
			onPointerUp={onPointerUp && (event => onPointerUp!(annotation, event))}
			onContextMenu={onContextMenu && (event => onContextMenu!(annotation, event))}
		>
			{/* Invisible thicker stroke for easier clicking */}
			<path
				d={pathData}
				fill="none"
				stroke="transparent"
				strokeWidth={Math.max(width * 3, 8)}
				strokeLinecap="round"
				strokeLinejoin="round"
				pointerEvents="stroke"
			/>
			{/* Visible stroke */}
			<path
				d={pathData}
				fill="none"
				stroke={annotation.color || '#000000'}
				strokeWidth={width}
				strokeLinecap="round"
				strokeLinejoin="round"
				opacity={selected ? 1 : 0.8}
				pointerEvents="none"
			/>
		</g>
	);
};
InkAnnotation.displayName = 'InkAnnotation';
InkAnnotation = memo(InkAnnotation);
type InkAnnotationProps = {
	annotation: DisplayedAnnotation;
	selected: boolean;
	onPointerDown?: (annotation: DisplayedAnnotation, event: React.PointerEvent) => void;
	onPointerUp?: (annotation: DisplayedAnnotation, event: React.PointerEvent) => void;
	onContextMenu?: (annotation: DisplayedAnnotation, event: React.MouseEvent) => void;
};

type AnnotationOverlayProps = {
	iframe: HTMLIFrameElement;
	annotations: DisplayedAnnotation[];
	selectedAnnotationIDs: string[];
	onPointerDown: (id: string, event: React.PointerEvent) => void;
	onPointerUp: (id: string, event: React.PointerEvent) => void;
	onContextMenu: (id: string, event: React.MouseEvent) => void;
	onDragStart: (id: string, dataTransfer: DataTransfer) => void;
	onResizeStart: (id: string) => void;
	onResizeEnd: (id: string, range: Range, cancelled: boolean) => void;
	onTextChange?: (id: string, text: string) => void;
};

let HighlightOrUnderline: React.FC<HighlightOrUnderlineProps> = (props) => {
	let { annotation, selected, singleSelection, onPointerDown, onPointerUp, onContextMenu, onDragStart, onResizeStart, onResizeEnd, widgetContainer } = props;
	let [isResizing, setResizing] = useState(false);
	let [resizedRange, setResizedRange] = useState(annotation.range);

	let outerGroupRef = useRef<SVGGElement>(null);
	let rectGroupRef = useRef<SVGGElement>(null);
	let dragImageRef = isSafari ? outerGroupRef : rectGroupRef;

	let handlePointerDown = useCallback((event: React.PointerEvent) => {
		onPointerDown?.(annotation, event);
	}, [annotation, onPointerDown]);

	let handlePointerUp = useCallback((event: React.PointerEvent) => {
		onPointerUp?.(annotation, event);
	}, [annotation, onPointerUp]);

	let handleContextMenu = useCallback((event: React.MouseEvent) => {
		onContextMenu?.(annotation, event);
	}, [annotation, onContextMenu]);

	let handleDragStart = useCallback((event: React.DragEvent) => {
		if (!onDragStart || annotation.text === undefined) {
			return;
		}

		let elem = dragImageRef.current;
		if (elem) {
			let br = elem.getBoundingClientRect();
			event.dataTransfer.setDragImage(elem, event.clientX - br.left, event.clientY - br.top);
		}
		onDragStart(annotation, event.dataTransfer);
	}, [annotation, dragImageRef, onDragStart]);

	let handleResizeStart = useCallback((annotation: DisplayedAnnotation) => {
		setResizing(true);
		setResizedRange(annotation.range);
		onResizeStart?.(annotation);
	}, [onResizeStart]);

	let handleResizeEnd = useCallback((annotation: DisplayedAnnotation, cancelled: boolean) => {
		setResizing(false);
		onResizeEnd?.(annotation, resizedRange, cancelled);
	}, [onResizeEnd, resizedRange]);

	let handleResize = useCallback((annotation: DisplayedAnnotation, range: Range) => {
		setResizedRange(range);
	}, []);

	let allowResize = selected && singleSelection && !annotation.readOnly && supportsCaretPositionFromPoint();

	useEffect(() => {
		if (!allowResize && isResizing) {
			handleResizeEnd(annotation, true);
		}
	}, [allowResize, annotation, handleResizeEnd, isResizing]);

	let { rects, interactiveRects, commentIconPosition } = useMemo(() => {
		let ranges = splitRangeToTextNodes(isResizing ? resizedRange : annotation.range);
		let rects = new Map<string, DOMRect>();
		let interactiveRects = new Set<DOMRect>();
		for (let range of ranges) {
			let closestInteractiveElement = range.startContainer.parentElement?.closest('a, area');
			for (let rect of getPageRects(range)) {
				if (rect.width == 0 || rect.height == 0) {
					continue;
				}
				let key = JSON.stringify(rect);
				if (!rects.has(key)) {
					rects.set(key, rect);
					if (closestInteractiveElement) {
						interactiveRects.add(rect);
					}
				}
			}
		}

		let commentIconPosition;
		if (annotation.comment) {
			let commentIconRange = ranges[0].cloneRange();
			collapseToOneCharacterAtStart(commentIconRange);
			let rect = getBoundingPageRect(commentIconRange);
			commentIconPosition = { x: rect.x, y: rect.y };
		}
		else {
			commentIconPosition = null;
		}

		return { rects: Array.from(rects.values()), interactiveRects, commentIconPosition };
	}, [annotation, isResizing, resizedRange]);

	let vert = isVertical(annotation.range.commonAncestorContainer);
	let rtl = isRTL(annotation.range.commonAncestorContainer);
	let underline = annotation.type === 'underline';
	let rectGroup = useMemo(() => {
		return <g ref={rectGroupRef}>
			{rects.map((rect, i) => (
				<rect
					x={vert && underline ? rect.x + (rtl ? -3 : rect.width) : rect.x}
					y={!vert && underline ? rect.y + rect.height : rect.y}
					width={vert && underline ? 3 : rect.width}
					height={!vert && underline ? 3 : rect.height}
					opacity="50%"
					key={i}
				/>
			))}
		</g>;
	}, [rects, rtl, underline, vert]);

	let foreignObjects = useMemo(() => {
		if (isResizing) {
			return [];
		}

		let isCoarsePointer = window.matchMedia('(pointer: coarse').matches;

		if (isCoarsePointer && isSafari) {
			// If the user is using a coarse pointer (touch device) on Safari:
			//  - Use the entire bounding rect as the tap target, with a 10px margin
			//  - Don't use a foreignObject, just a normal rect, because Safari
			//    makes foreignObjects eat all pointer events within their bounds
			//    with no regard for Z ordering. The foreignObject isn't necessary
			//    on mobile anyway because we don't support dragging.
			let rect = expandRect(getBoundingRect(rects), 10);
			return (
				<rect
					fill="transparent"
					x={rect.x}
					y={rect.y}
					width={rect.width}
					height={rect.height}
					className="needs-pointer-events annotation-div"
					onPointerDown={handlePointerDown}
					onPointerUp={handlePointerUp}
					onContextMenu={handleContextMenu}
					data-annotation-id={annotation.id}
				/>
			);
		}

		let clickTargetRects = isCoarsePointer
			// As in the Safari case above, use the full bounding rect as the tap
			// target if the user is using a touch device
			? [expandRect(getBoundingRect(rects), 10)]
			: rects;

		return clickTargetRects.map((rect, i) => (
			// Yes, this is horrible, but SVGs don't support drag events without embedding HTML in a <foreignObject>
			<foreignObject
				x={rect.x}
				y={rect.y}
				width={rect.width}
				height={rect.height}
				className="needs-pointer-events"
				key={i + '-foreign'}
			>
				<div
					className={cx('annotation-div', { 'disable-pointer-events': interactiveRects.has(rect) })}
					// Safari needs position: absolute, which breaks all other browsers
					style={isSafari ? { position: 'absolute', top: `${rect.y}px`, left: `${rect.x}px`, width: `${rect.width}px`, height: `${rect.height}px` } : undefined}
					draggable={true}
					onPointerDown={handlePointerDown}
					onPointerUp={handlePointerUp}
					onContextMenu={handleContextMenu}
					onDragStart={handleDragStart}
					data-annotation-id={annotation.id}
				/>
			</foreignObject>
		));
	}, [annotation, handleContextMenu, handleDragStart, handlePointerDown, handlePointerUp, interactiveRects, isResizing, rects]);

	let resizer = useMemo(() => {
		return allowResize && (
			<Resizer
				annotation={annotation}
				highlightRects={rects}
				onResizeStart={handleResizeStart}
				onResizeEnd={handleResizeEnd}
				onResize={handleResize}
			/>
		);
	}, [allowResize, annotation, handleResize, handleResizeEnd, handleResizeStart, rects]);

	if (!rects.length) {
		return null;
	}

	// When the user drags the annotation, we *want* to set the drag image to the rendered annotation -- a highlight
	// rectangle for a highlight annotation, an underline for an underline annotation. We don't want to include
	// resizers. But in Safari, passing an SVG sub-element to setDragImage() doesn't actually set the drag image to the
	// rendered content of that element, but rather to all the text contained within its bounding box (but not
	// necessarily within the element itself in the DOM tree). This is very weird and means that underline annotations
	// will have a blank drag image because the underline doesn't overlap any text. So when running in Safari, we pass
	// the whole outer <g> containing the underline/highlight (potentially small) and the interactive <foreignObject>s
	// (big) so that we get all the highlighted text to render in the drag image.
	return <>
		<g
			tabIndex={-1}
			data-annotation-id={annotation.id}
			fill={annotation.color}
			ref={outerGroupRef}
		>
			{rectGroup}
			{foreignObjects}
			{resizer}
		</g>
		{widgetContainer && ((selected && !isResizing) || commentIconPosition) && ReactDOM.createPortal(
			<>
				{selected && !isResizing && (
					<SplitSelectionBorder range={annotation.range}/>
				)}
				{commentIconPosition && (
					<CommentIcon {...commentIconPosition} color={annotation.color!}/>
				)}
			</>,
			widgetContainer
		)}
	</>;
};
HighlightOrUnderline.displayName = 'HighlightOrUnderline';
HighlightOrUnderline = memo(HighlightOrUnderline);
type HighlightOrUnderlineProps = {
	annotation: DisplayedAnnotation;
	selected: boolean;
	singleSelection: boolean;
	onPointerDown?: (annotation: DisplayedAnnotation, event: React.PointerEvent) => void;
	onPointerUp?: (annotation: DisplayedAnnotation, event: React.PointerEvent) => void;
	onContextMenu?: (annotation: DisplayedAnnotation, event: React.MouseEvent) => void;
	onDragStart?: (annotation: DisplayedAnnotation, dataTransfer: DataTransfer) => void;
	onResizeStart?: (annotation: DisplayedAnnotation) => void;
	onResizeEnd?: (annotation: DisplayedAnnotation, range: Range, cancelled: boolean) => void;
	widgetContainer: Element | null;
};

const Note: React.FC<NoteProps> = (props) => {
	let { annotation, staggerIndex, selected, onPointerDown, onPointerUp, onContextMenu, onDragStart } = props;

	let dragImageRef = useRef<SVGSVGElement>(null);
	let doc = annotation.range.commonAncestorContainer.ownerDocument;

	let handleDragStart = useCallback((event: React.DragEvent) => {
		if (!onDragStart || annotation.comment === undefined) {
			return;
		}
		let elem = dragImageRef.current;
		if (elem) {
			let br = elem.getBoundingClientRect();
			event.dataTransfer.setDragImage(elem, event.clientX - br.left, event.clientY - br.top);
		}
		onDragStart(annotation, event.dataTransfer);
	}, [annotation, onDragStart]);

	if (!doc || !doc.defaultView) {
		return null;
	}

	let rect = annotation.range.getBoundingClientRect();
	rect.x += doc.defaultView.scrollX;
	rect.y += doc.defaultView.scrollY;
	let rtl = isRTL(annotation.range.commonAncestorContainer);
	let staggerOffset = (staggerIndex || 0) * 15;
	let x = rect.left + (rtl ? -25 : rect.width + 25) + (rtl ? -1 : 1) * staggerOffset;
	let y = rect.top + staggerOffset;
	return (
		<CommentIcon
			ref={dragImageRef}
			annotation={annotation}
			x={x}
			y={y}
			color={annotation.color!}
			opacity={annotation.id ? '100%' : '50%'}
			selected={selected}
			large={true}
			tabIndex={-1}
			onPointerDown={onPointerDown && (event => onPointerDown!(annotation, event))}
			onPointerUp={onPointerUp && (event => onPointerUp!(annotation, event))}
			onContextMenu={onContextMenu && (event => onContextMenu!(annotation, event))}
			onDragStart={handleDragStart}
		/>
	);
};
Note.displayName = 'Note';
type NoteProps = {
	annotation: DisplayedAnnotation,
	staggerIndex?: number,
	selected: boolean;
	onPointerDown?: (annotation: DisplayedAnnotation, event: React.PointerEvent) => void;
	onPointerUp?: (annotation: DisplayedAnnotation, event: React.PointerEvent) => void;
	onContextMenu?: (annotation: DisplayedAnnotation, event: React.MouseEvent) => void;
	onDragStart?: (annotation: DisplayedAnnotation, dataTransfer: DataTransfer) => void;
};

let NotePreview: React.FC<NotePreviewProps> = (props) => {
	let { annotation } = props;
	let doc = annotation.range.commonAncestorContainer.ownerDocument;
	if (!doc || !doc.defaultView) {
		return null;
	}

	let rect = annotation.range.getBoundingClientRect();
	rect.x += doc.defaultView.scrollX;
	rect.y += doc.defaultView.scrollY;
	return <SelectionBorder rect={rect} preview={true} key={annotation.key} />;
};
NotePreview.displayName = 'NotePreview';
NotePreview = memo(NotePreview);
type NotePreviewProps = {
	annotation: DisplayedAnnotation;
};

const StaggeredNotes: React.FC<StaggeredNotesProps> = (props) => {
	let { annotations, selectedAnnotationIDs, onPointerDown, onPointerUp, onContextMenu, onDragStart } = props;
	let staggerMap = new Map<string | undefined, number>();
	return <>
		{annotations.map((annotation) => {
			let stagger = staggerMap.has(annotation.sortIndex) ? staggerMap.get(annotation.sortIndex)! : 0;
			staggerMap.set(annotation.sortIndex, stagger + 1);
			if (annotation.id) {
				return (
					<Note
						annotation={annotation}
						staggerIndex={stagger}
						key={annotation.key}
						selected={selectedAnnotationIDs.includes(annotation.id)}
						onPointerDown={onPointerDown}
						onPointerUp={onPointerUp}
						onContextMenu={onContextMenu}
						onDragStart={onDragStart}
					/>
				);
			}
			else {
				return (
					<div className="disable-pointer-events" key={annotation.key}>
						<Note
							annotation={annotation}
							staggerIndex={stagger}
							key={annotation.key}
							selected={false}
						/>
					</div>
				);
			}
		})}
	</>;
};
StaggeredNotes.displayName = 'StaggeredNotes';
type StaggeredNotesProps = {
	annotations: DisplayedAnnotation[];
	selectedAnnotationIDs: string[];
	onPointerDown: (annotation: DisplayedAnnotation, event: React.PointerEvent) => void;
	onPointerUp: (annotation: DisplayedAnnotation, event: React.PointerEvent) => void;
	onContextMenu: (annotation: DisplayedAnnotation, event: React.MouseEvent) => void;
	onDragStart: (annotation: DisplayedAnnotation, dataTransfer: DataTransfer) => void;
};

let SelectionBorder: React.FC<SelectionBorderProps> = (props) => {
	let { rect, preview } = props;
	return (
		<rect
			x={rect.left - 5}
			y={rect.top - 5}
			width={rect.width + 10}
			height={rect.height + 10}
			fill="none"
			stroke={preview ? '#aaaaaa' : '#6d95e0'}
			strokeDasharray="10 6"
			strokeWidth={2}/>
	);
};
SelectionBorder.displayName = 'SelectionBorder';
SelectionBorder = memo(SelectionBorder, (prev, next) => {
	return rectsEqual(prev.rect, next.rect) && prev.preview === next.preview;
});
type SelectionBorderProps = {
	rect: DOMRect;
	preview?: boolean;
};

let SplitSelectionBorder: React.FC<SplitSelectionBorderProps> = (props) => {
	let { range } = props;
	return (
		<>
			{getColumnSeparatedPageRects(range)
				.map((sectionRect, i) => <SelectionBorder rect={sectionRect} key={i}/>)}
		</>
	);
};
SplitSelectionBorder.displayName = 'SelectionBorder';
type SplitSelectionBorderProps = {
	range: Range;
};

const Resizer: React.FC<ResizerProps> = (props) => {
	let { annotation, highlightRects, onResize, onResizeEnd, onResizeStart } = props;

	let [resizingSide, setResizingSide] = useState<false | 'start' | 'end'>(false);
	let [pointerCapture, setPointerCapture] = useState<{ elem: Element, pointerId: number } | null>(null);
	let [lastPointerMove, setLastPointerMove] = useState<React.PointerEvent | null>(null);

	let isCoarsePointer = window.matchMedia('(pointer: coarse').matches;
	let size = isCoarsePointer ? 6 : 3;

	let handlePointerDown = useCallback((event: React.PointerEvent) => {
		if (event.button !== 0) {
			return;
		}
		event.preventDefault();
		(event.target as Element).setPointerCapture(event.pointerId);
	}, []);

	let handlePointerUp = useCallback((event: React.PointerEvent) => {
		if (event.button !== 0
				|| !resizingSide
				|| !(event.target as Element).hasPointerCapture(event.pointerId)) {
			return;
		}
		(event.target as Element).releasePointerCapture(event.pointerId);
	}, [resizingSide]);

	let handleGotPointerCapture = useCallback((event: React.PointerEvent, side: 'start' | 'end') => {
		setResizingSide(side);
		setPointerCapture({ elem: event.target as Element, pointerId: event.pointerId });
		onResizeStart(annotation);
	}, [annotation, onResizeStart]);

	let handleLostPointerCapture = useCallback(() => {
		setResizingSide(false);
		if (pointerCapture) {
			setPointerCapture(null);
			setLastPointerMove(null);
			onResizeEnd(annotation, false);
		}
	}, [annotation, onResizeEnd, pointerCapture]);

	let handleKeyDown = useCallback((event: KeyboardEvent) => {
		if (event.key !== 'Escape' || !resizingSide || !pointerCapture) {
			return;
		}
		pointerCapture.elem.releasePointerCapture(pointerCapture.pointerId);
		setResizingSide(false);
		setPointerCapture(null);
		onResizeEnd(annotation, true);
	}, [pointerCapture, onResizeEnd, annotation, resizingSide]);

	const doc = annotation.range.commonAncestorContainer.ownerDocument;
	const win = doc?.defaultView;

	useEffect(() => {
		if (!win) {
			return undefined;
		}
		win.addEventListener('keydown', handleKeyDown, true);
		return () => win.removeEventListener('keydown', handleKeyDown, true);
	}, [win, handleKeyDown]);

	let handlePointerMove = useCallback((event: React.PointerEvent) => {
		let { clientX, clientY } = event;
		let isStart = resizingSide === 'start';
		if (isSafari) {
			let targetRect = (event.target as Element).getBoundingClientRect();
			if (clientX >= targetRect.left && clientX <= targetRect.right) {
				// In Safari, caretPositionFromPoint() doesn't work if the mouse is directly over the target element
				// (returns the last element in the body instead), so we have to offset the X position by 1 pixel.
				// This makes resizing a bit jerkier, but it's better than the alternative.
				clientX = isStart ? targetRect.left - 1 : targetRect.right + 1;
			}
		}
		let pos = caretPositionFromPoint(event.view.document, clientX, clientY);
		if (pos) {
			// Just bail if the browser thinks the mouse is over the SVG - that seems to only happen momentarily
			if (pos.offsetNode.nodeType == Node.ELEMENT_NODE && (pos.offsetNode as Element).closest('svg')) {
				return;
			}

			let relativePosition = annotation.range.comparePoint(pos.offsetNode, pos.offset);
			let newRange = annotation.range.cloneRange();
			if (isStart) {
				if (relativePosition <= 0) {
					newRange.setStart(pos.offsetNode, pos.offset);
				}
				else {
					// Resizing the start past the end - swap the two
					newRange.setStart(newRange.endContainer, newRange.endOffset);
					newRange.setEnd(pos.offsetNode, pos.offset);
				}
			}
			else {
				// eslint-disable-next-line no-lonely-if
				if (relativePosition >= 0) {
					newRange.setEnd(pos.offsetNode, pos.offset);
				}
				else {
					// Resizing the end past the start - swap the two
					newRange.setEnd(newRange.startContainer, newRange.startOffset);
					newRange.setStart(pos.offsetNode, pos.offset);
				}
			}

			if (newRange.collapsed
					|| !newRange.toString().trim().length
					|| newRange.getClientRects().length == 0
					// Make sure we stay within one section
					|| doc?.querySelector('[data-section-index]')
						&& !closestElement(newRange.commonAncestorContainer)?.closest('[data-section-index]')) {
				return;
			}
			let boundingRect = newRange.getBoundingClientRect();
			if (!boundingRect.width || !boundingRect.height) {
				return;
			}

			onResize(annotation, newRange);
		}

		if (win) {
			setLastPointerMove(event);
		}
	}, [annotation, doc, onResize, resizingSide, win]);

	useEffect(() => {
		if (!win || !resizingSide || !lastPointerMove) {
			return undefined;
		}
		let scrollAmount = lastPointerMove.clientY < 50 ? -10 : lastPointerMove.clientY >= win.innerHeight - 50 ? 10 : 0;
		if (!scrollAmount) {
			return undefined;
		}

		win.scrollBy({ top: scrollAmount });
		let intervalID = win.setInterval(() => {
			win.scrollBy({ top: scrollAmount });
		}, 20);
		return () => win.clearInterval(intervalID);
	}, [lastPointerMove, resizingSide, win]);

	useEffect(() => {
		if (!win || !resizingSide || !lastPointerMove) {
			return undefined;
		}
		let handleScroll = () => {
			handlePointerMove(lastPointerMove!);
		};
		win.addEventListener('scroll', handleScroll);
		return () => win.removeEventListener('scroll', handleScroll);
	}, [handlePointerMove, lastPointerMove, resizingSide, win]);

	if (!highlightRects.length) {
		return null;
	}

	let vert = isVertical(annotation.range.commonAncestorContainer);
	let topLeftRect = highlightRects[0];
	let bottomRightRect = highlightRects[highlightRects.length - 1];
	return <>
		<rect
			x={vert ? topLeftRect.left : topLeftRect.left - size}
			y={vert ? topLeftRect.top - size : topLeftRect.top}
			width={vert ? topLeftRect.width : size}
			height={vert ? size : topLeftRect.height}
			fill={annotation.color}
			className={cx('resizer inherit-pointer-events', { 'resizer-vertical': vert })}
			onPointerDown={handlePointerDown}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
			onPointerMove={resizingSide == 'start' ? (event => handlePointerMove(event)) : undefined}
			onGotPointerCapture={event => handleGotPointerCapture(event, 'start')}
			onLostPointerCapture={handleLostPointerCapture}
		/>
		<rect
			x={vert ? bottomRightRect.left : bottomRightRect.right}
			y={vert ? bottomRightRect.bottom : bottomRightRect.top}
			width={vert ? bottomRightRect.width : size}
			height={vert ? size : bottomRightRect.height}
			fill={annotation.color}
			className={cx("resizer inherit-pointer-events", { 'resizer-vertical': vert })}
			onPointerDown={handlePointerDown}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
			onPointerMove={resizingSide == 'end' ? (event => handlePointerMove(event)) : undefined}
			onGotPointerCapture={event => handleGotPointerCapture(event, 'end')}
			onLostPointerCapture={handleLostPointerCapture}
		/>
	</>;
};
Resizer.displayName = 'Resizer';
type ResizerProps = {
	annotation: DisplayedAnnotation;
	highlightRects: DOMRect[];
	onResizeStart: (annotation: DisplayedAnnotation) => void;
	onResizeEnd: (annotation: DisplayedAnnotation, cancelled: boolean) => void;
	onResize: (annotation: DisplayedAnnotation, range: Range) => void;
};

let CommentIcon = React.forwardRef<SVGSVGElement, CommentIconProps>((props, ref) => {
	let size = props.large ? 24 : 14;
	let x = props.x - size / 2;
	let y = props.y - size / 2;
	return <>
		<svg
			color={props.color}
			opacity={props.opacity}
			x={x}
			y={y}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			data-annotation-id={props.annotation?.id}
			ref={ref}
		>
			<IconNoteLarge/>
		</svg>
		{props.selected && (
			<SelectionBorder rect={new DOMRect(x, y, size, size)}/>
		)}
		<foreignObject
			x={x}
			y={y}
			width={size}
			height={size}
			className="needs-pointer-events"
			tabIndex={props.tabIndex}
			data-annotation-id={props.annotation?.id}
		>
			<div
				// @ts-ignore
				xmlns="http://www.w3.org/1999/xhtml"
				className="annotation-div"
				draggable={true}
				onPointerDown={props.onPointerDown}
				onPointerUp={props.onPointerUp}
				onContextMenu={props.onContextMenu}
				onDragStart={props.onDragStart}
				onDragEnd={props.onDragEnd}
				data-annotation-id={props.annotation?.id}
			/>
		</foreignObject>
	</>;
});
CommentIcon.displayName = 'CommentIcon';
CommentIcon = memo(CommentIcon);
type CommentIconProps = {
	annotation?: { id?: string },
	x: number;
	y: number;
	color: string;
	opacity?: string | number;
	selected?: boolean;
	large?: boolean;
	tabIndex?: number;
	onPointerDown?: (event: React.PointerEvent) => void;
	onPointerUp?: (event: React.PointerEvent) => void;
	onContextMenu?: (event: React.MouseEvent) => void;
	onDragStart?: (event: React.DragEvent) => void;
	onDragEnd?: (event: React.DragEvent) => void;
};
