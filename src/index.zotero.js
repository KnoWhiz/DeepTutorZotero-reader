import Reader from './common/reader';
import './fluent';

// Helper function that can be called from outside the iframe
// It waits for _reader to be ready, then calls setFindQuery
window.setFindQueryWhenReady = async (query, options = {}) => {
	console.log('[setFindQueryWhenReady] Called with query length:', query?.length);
	console.log('[setFindQueryWhenReady] Options:', JSON.stringify(options));
	console.log('[setFindQueryWhenReady] window._reader exists:', !!window._reader);
	console.log('[setFindQueryWhenReady] window.createReader exists:', typeof window.createReader);
	console.log('[setFindQueryWhenReady] window location:', window.location?.href);
	console.log('[setFindQueryWhenReady] window === window.top:', window === window.top);
	
	// Wait for _reader to exist (max 10 seconds)
	const startTime = Date.now();
	let waitCount = 0;
	while (!window._reader && Date.now() - startTime < 10000) {
		waitCount++;
		if (waitCount % 10 === 0) {
			console.log('[setFindQueryWhenReady] Still waiting for _reader...', waitCount * 100, 'ms');
		}
		await new Promise(r => setTimeout(r, 100));
	}
	
	if (!window._reader) {
		console.error('[setFindQueryWhenReady] ERROR: _reader not available after timeout');
		return;
	}
	
	console.log('[setFindQueryWhenReady] _reader is ready! Waited', Date.now() - startTime, 'ms');
	console.log('[setFindQueryWhenReady] Calling _reader.setFindQuery...');
	
	try {
		window._reader.setFindQuery(query, options);
		console.log('[setFindQueryWhenReady] setFindQuery completed successfully');
	}
	catch (error) {
		console.error('[setFindQueryWhenReady] setFindQuery ERROR:', error);
	}
};

window.createReader = (options) => {
	console.log('[createReader] STARTING');
	console.log('[createReader] window._reader already exists:', !!window._reader);
	console.log('[createReader] window location:', window.location?.href);
	
	// Note: window._reader is now set early in Reader constructor
	// So it may already exist when we get here (if constructor is still running)
	// We only throw if there's ALREADY a fully constructed reader
	if (window._reader && window._reader._constructorCompleted) {
		throw new Error('Reader is already initialized');
	}
	options.platform = 'zotero';

	let { onOpenContextMenu } = options;
	let reader;
	options.onOpenContextMenu = (params) => {
		if (params.internal) {
			// Use reader if available, otherwise fall back to window._reader
			const readerInstance = reader || window._reader;
			if (readerInstance) {
				readerInstance.openContextMenu(params);
			}
			return;
		}
		window.contextMenuParams = params;
		onOpenContextMenu(params);
	};

	let { onSaveAnnotations } = options;
	// Reader iframe doesn't have permissions to wait for onSaveAnnotations
	// promise, therefore using callback to inform when saving finishes
	options.onSaveAnnotations = async (annotations) => {
		return new Promise((resolve) => {
			onSaveAnnotations(annotations, resolve);
		});
	};

	reader = new Reader(options);
	window._reader = reader;
	console.log('[createReader] COMPLETED - window._reader is now SET');
	console.log('[createReader] window._reader exists:', !!window._reader);
	return reader;
};
