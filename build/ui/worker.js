import { execute } from '../core/runtime.js';
let controller = null;
self.onmessage = async (event) => {
    if (event.data.type === 'cancel') {
        controller?.abort();
        return;
    }
    if (event.data.type !== 'run' || !event.data.document || !event.data.files)
        return;
    if (controller) {
        self.postMessage({ type: 'error', message: 'Исполнитель уже занят' });
        return;
    }
    controller = new AbortController();
    try {
        const run = await execute(event.data.document, event.data.files, { signal: controller.signal, concurrency: event.data.concurrency ?? 2, onUpdate: run => self.postMessage({ type: 'update', run }) });
        self.postMessage({ type: 'done', run });
    }
    catch (error) {
        self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    finally {
        controller = null;
    }
};
